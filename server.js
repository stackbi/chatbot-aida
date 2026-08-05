import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import path from "path";
import { fileURLToPath } from "url";
import { rateLimit } from "express-rate-limit";
import { createRequire } from "module";
import crypto from "crypto";
import {
  getSettings,
  saveSettings,
  getDocuments,
  addDocument,
  deleteDocument,
  isStoragePersistent,
  getStorageStatus
} from "./lib/store.js";
import { retrieveRelevantChunksSync, buildChunkIndex, buildContextBlock } from "./lib/retrieval.js";
import { ensureEmbeddingModel, generateEmbedding, findSimilarChunks, cosineSimilarity } from "./lib/embedding.js";
import { correctText } from "./lib/spellcheck.js";
import { searchSiteContent, buildSiteContextBlock, isSafeSiteUrl } from "./lib/site-explorer.js";

const require = createRequire(import.meta.url);
const { PDFParse } = require("pdf-parse");

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Derrière un reverse proxy (Railway, Render, Nginx…) : active le trust proxy
// pour que le rate limiting et req.ip utilisent la vraie IP du visiteur.
// À activer UNIQUEMENT si le serveur est derrière un proxy de confiance.
// Valeurs explicites pour désactiver : "false", "0", "off".
const trustProxy = process.env.TRUST_PROXY;
if (trustProxy && !/^(false|0|off|no)$/i.test(trustProxy)) {
  app.set("trust proxy", Number(trustProxy) || 1);
}

app.use(express.json({ limit: "20mb" }));
// 20 Mo pour supporter le surcoût base64 des uploads PDF (10 Mo fichier → ~13,3 Mo base64)

// ─── Headers de sécurité HTTP ──────────────────────────────────────────
// CSP configuré pour permettre l'embedding du widget sur n'importe quel site
// tout en bloquant les injections XSS et le MIME sniffing.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
      formAction: ["'self'"],
      frameAncestors: ["*"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));

app.use(express.static(path.join(__dirname, "public")));
app.use("/admin", express.static(path.join(__dirname, "admin")));

// ─── CORS widget ────────────────────────────────────────────────────────
// Le widget est chargé depuis le domaine du client (son propre site), donc les routes
// qu'il appelle doivent accepter les requêtes cross-origin. Le tableau de bord admin,
// lui, est toujours servi et utilisé depuis ce même backend, donc pas besoin de CORS
// sur les routes /api/admin/*.
//
// Optionnel : restreindre les origines autorisées via la variable d'environnement CORS_ORIGINS
// (séparateur virgule). Exemple : CORS_ORIGINS=https://monsite.com,https://client2.com
const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map(s => s.trim()).filter(Boolean)
  : true;
const widgetCors = cors({ origin: corsOrigins, methods: ["GET", "POST"] });

// En-têtes OpenRouter pour identifier l'application dans le dashboard
const OR_HEADERS = {
  "HTTP-Referer": process.env.SITE_URL || "https://aida-chatbot.local",
  "X-Title": "Aïda Chatbot"
};

/**
 * Comparaison de chaînes à temps constant (évite les attaques par timing
 * sur le mot de passe admin).
 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Liste des modèles de fallback en cas de rate limit (429)
const FALLBACK_MODELS = ["openrouter/free"];

/**
 * Détecte si une URL pointe vers une instance locale (Ollama, LM Studio…)
 * qui ne requiert pas de clé API. Toute autre API distante (SiliconFlow,
 * OpenRouter, etc.) exige un en-tête Authorization.
 */
function isLocalHostUrl(url) {
  try {
    // Supprime les crochets des adresses IPv6 littérales (Node renvoie "[::1]")
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return (
      host === "localhost" ||
      /^127\./.test(host) ||
      host === "::1" ||
      host === "0.0.0.0" ||
      /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(host)
    );
  } catch {
    return false;
  }
}

/**
 * Filtre les annotations de sécurité des fournisseurs IA
 * qui peuvent fuiter dans le contenu de la réponse.
 * Patterns connus : "User Safety: safe", "Response Safety: safe"
 *
 * @param {Object} [opts] - Options
 * @param {boolean} [opts.trim=true] - Trim des bords. DOIT être false pour un
 *   token SSE individuel : le trim supprimerait les espaces de tête/fin qui
 *   séparent les mots (ex: " sommes" → "sommes"), collant tout le texte.
 */
function filterAIContent(text, { trim = true } = {}) {
  if (!text) return "";
  const result = text
    .replace(/User Safety:\s*safe\s*/gi, "")
    .replace(/Response Safety:\s*safe\s*/gi, "")
    .replace(/\n{3,}/g, "\n\n");
  return trim ? result.trim() : result;
}

/**
 * Normalise les espaces dans la réponse de l'IA.
 * Corrige les mots collés entre eux et les problèmes de ponctuation.
 * S'adapte au français (lettres accentuées comprises).
 *
 * @param {Object} [opts] - Options
 * @param {boolean} [opts.trim=true] - Trim des bords. DOIT être false pour un
 *   token SSE individuel : le trim supprimerait les espaces de tête/fin qui
 *   séparent les mots (ex: " sommes" → "sommes"), collant tout le texte.
 */
function normalizeSpacing(text, { trim = true } = {}) {
  if (!text) return "";

  // Lettres latines (incluant les accents français)
  const letters = "A-Za-zÀ-ÖØ-öø-ÿéèêëàâäùûüôöîïçÉÈÊËÀÂÄÙÛÜÔÖÎÏÇ";

  const result = text
    // 1) Normalise TOUS les types d'espaces Unicode vers U+0020
    // (non-breaking space, narrow no-break space, espace insécable fine, etc.)
    .replace(/[\u00A0\u202F\u2000-\u200A\u200B\u2060]/g, " ")
    // 2) Espace APRÈS . ! ? suivi d'une lettre (nouvelle phrase)
    .replace(new RegExp(`([.!?])([${letters}])`, "g"), "$1 $2")
    // 3) Espace APRÈS , ; : suivi d'une lettre
    .replace(new RegExp(`([,;:])([${letters}])`, "g"), "$1 $2")
    // 4) Espace APRÈS « " ( suivi d'une lettre (guillemet/parenthèse ouvrant)
    .replace(new RegExp(`([«"(])([${letters}])`, "g"), "$1 $2")
    // 5) Espace AVANT » ) " fermant après une lettre ou ponctuation
    .replace(new RegExp(`([${letters}\!\?\.,;:])([»\)"])`, "g"), "$1 $2")
    // 6) Supprime les espaces multiples
    .replace(/[ ]{2,}/g, " ")
    // 7) Normalise les retours à la ligne
    .replace(/\n{3,}/g, "\n\n");

  return trim ? result.trim() : result;
}

/**
 * Fait un appel API OpenAI-compatible vers une URL donnée.
 * Retourne { ok, data, modelUsed, errText, status }.
 */
async function apiCall({ baseUrl, apiKey, model, messages, maxTokens, extraHeaders }) {
  const headers = {
    "Content-Type": "application/json",
    // N'ajoute le header Authorization que si une clé est fournie
    // (utile pour Ollama/localhost qui n'en nécessite pas)
    ...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}),
    ...(extraHeaders || {})
  };

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        max_tokens: maxTokens || 800,
        temperature: 0.3,
        messages
      })
    });

    if (response.ok) {
      const data = await response.json();
      return { ok: true, data, modelUsed: data.model || model };
    }

    const errText = await response.text();
    return { ok: false, status: response.status, errText };
  } catch (err) {
    console.error(`Erreur réseau API (${baseUrl}):`, err.message);
    return { ok: false, status: 503, errText: err.message || "Erreur réseau" };
  }
}

/**
 * Appel API en streaming (SSE) — écrit chaque token directement dans la réponse HTTP.
 * Compatible OpenAI / OpenRouter / Groq / tout fournisseur OpenAI-like.
 */
// Durée sans aucun token après laquelle un stream est considéré comme mort
// (connexion coupée, provider muet). Un flux lent mais régulier n'est PAS coupé.
const STREAM_IDLE_TIMEOUT_MS = 45000;

async function apiCallStream({ baseUrl, apiKey, model, messages, maxTokens, extraHeaders, res, signal }) {
  const headers = {
    "Content-Type": "application/json",
    ...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}),
    ...(extraHeaders || {})
  };

  // Contrôle interne : annule l'appel si aucun token n'arrive pendant une
  // longue période (provider muet ou connexion morte). Le signal passé par
  // l'appelant (abortController du route) reste prioritaire : il est déclenché
  // quand le client se déconnecte.
  const internalController = new AbortController();
  const combinedSignal = signal
    ? AbortSignal.any([signal, internalController.signal])
    : internalController.signal;

  let idleTimer = null;
  const restartIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      console.warn(`⏱️ Aucun token reçu pendant ${STREAM_IDLE_TIMEOUT_MS / 1000}s — stream annulé (${baseUrl})`);
      internalController.abort();
    }, STREAM_IDLE_TIMEOUT_MS);
  };
  restartIdleTimer();

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      signal: combinedSignal,
      body: JSON.stringify({
        model,
        max_tokens: maxTokens || 800,
        temperature: 0.3,
        messages,
        stream: true
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      clearTimeout(idleTimer); // pas de watchdog résiduel sur ce chemin
      return { ok: false, status: response.status, errText };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = "";
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) restartIdleTimer(); // activité → reset du watchdog

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      let doneReceived = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") { doneReceived = true; break; }

        try {
          const parsed = JSON.parse(data);
          const rawToken = parsed.choices?.[0]?.delta?.content || "";
          if (rawToken) {
            // Nettoie les annotations de sécurité SANS trimmer : les tokens SSE
            // arrivent souvent avec un espace de tête (ex: " sommes"). Tout trim
            // supprimerait cet espace et collerait les mots entre eux.
            const cleaned = filterAIContent(rawToken, { trim: false });
            if (cleaned) {
              fullContent += rawToken; // conserve l'original pour fullContent (filtré à la fin)
              // Normalise l'espacement interne du token (ponctuation) sans toucher
              // aux bords : les espaces inter-mots sont préservés.
              const spacedToken = normalizeSpacing(cleaned, { trim: false });
              // Écrit directement dans la réponse SSE (ignore si le client est parti)
              if (!res.writableEnded && !res.destroyed) {
                res.write(`data: ${JSON.stringify({ token: spacedToken })}\n\n`);
              }
            }
          }
        } catch { /* ignorer les lignes mal formées */ }
      }
      if (doneReceived) break;
    }

    clearTimeout(idleTimer);
    // Le signal de fin (done) est envoyé par la route appelante avec les métadonnées
    return { ok: true, fullContent: filterAIContent(fullContent) };
  } catch (err) {
    clearTimeout(idleTimer);
    if (err.name === "AbortError") {
      return { ok: false, status: 499, errText: "Requête annulée" };
    }
    console.error(`Erreur réseau streaming (${baseUrl}):`, err.message);
    return { ok: false, status: 503, errText: err.message || "Erreur réseau" };
  }
}

/**
 * Retourne la liste ordonnée des providers à essayer.
 * L'ordre dynamique place le provider ayant une clé API en premier :
 *   - Si une clé OpenRouter est configurée → OpenRouter en tête
 *   - Sinon → le premier provider non-OpenRouter configuré devient le primary
 * Cela permet d'utiliser Groq, OpenAI ou une API locale
 * comme fournisseur principal, sans dépendre d'OpenRouter.
 */
function getFallbackProviders(settings) {
  const providers = [];
  const configuredModel = settings.model || "openrouter/free";

  // 1) OpenRouter : seulement si une clé est présente
  if (settings.apiKey) {
    const orModels = [configuredModel];
    for (const fb of FALLBACK_MODELS) {
      if (fb !== configuredModel) orModels.push(fb);
    }
    for (const m of orModels) {
      providers.push({
        name: "OpenRouter",
        model: m,
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: settings.apiKey,
        extraHeaders: OR_HEADERS
      });
    }
  }    // 2) Groq (gratuit, fallback #1 ou primary si pas d'OpenRouter) — modèles fiables
  if (settings.groqApiKey) {
    // Chaîne de modèles Groq validés (doc officielle) : le premier disponible répond,
    // sinon le suivant est essayé. GPT-OSS 120B : le plus performant ; Llama 3.3 70B :
    // modèle historique fiable ; GPT-OSS 20B : ultra-rapide (~1000 t/s).
    const GROQ_MODELS = ["openai/gpt-oss-120b", "llama-3.3-70b-versatile", "openai/gpt-oss-20b"];
    for (const gm of GROQ_MODELS) {
      providers.push({
        name: "Groq",
        model: gm,
        baseUrl: "https://api.groq.com/openai/v1",
        apiKey: settings.groqApiKey
      });
    }
  }

  // 3) API personnalisée (fallback #2)
  if (settings.customApiUrl) {
    const url = settings.customApiUrl.replace(/\/+$/, "");
    // Une API distante (SiliconFlow, OpenRouter…) exige une clé API :
    // sans elle, la requête part sans en-tête Authorization →
    // erreur 401 « Missing Authentication header ».
    // Seules les instances locales (Ollama, LM Studio…) fonctionnent sans clé.
    const requiresAuth = !isLocalHostUrl(url);
    if (requiresAuth && !settings.customApiKey) {
      console.warn(`⚠️ API personnalisée ignorée : une clé API est requise pour ${url} (hôte distant).`);
    } else {
      providers.push({
        name: requiresAuth ? "API personnalisée" : "API locale",
        model: settings.customApiModel || "llama3.1-8b",
        baseUrl: url,
        apiKey: settings.customApiKey || ""
      });
    }
  }

  // 4) OpenAI (fallback #3, payant)
  if (settings.openaiApiKey) {
    providers.push({
      name: "OpenAI",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
      apiKey: settings.openaiApiKey
    });
  }

  return providers;
}

/**
 * Parcourt la chaîne de providers avec backoff exponentiel.
 * Appelle `apiCaller(provider, options)` pour chaque tentative.
 * Retourne le premier résultat ok ou le dernier échec.
 */
async function tryProviderChain(providers, apiCaller, options) {
  let lastResult = null;

  // Aucun fournisseur utilisable (ex : API distante configurée sans clé API)
  if (!providers || providers.length === 0) {
    return {
      ok: false,
      status: 503,
      errText: "Aucun fournisseur correctement configuré (clé API manquante)."
    };
  }

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];

    // Backoff exponentiel avant chaque fallback (sauf le premier)
    if (i > 0) {
      const delayMs = Math.min(200 * Math.pow(2, i - 1), 2000);
      console.warn(`⏳ Fallback ${provider.name} (attente ${delayMs}ms)...`);
      await new Promise(r => setTimeout(r, delayMs));
    }

    const result = await apiCaller({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: provider.model,
      messages: options.messages,
      maxTokens: options.maxTokens,
      extraHeaders: provider.extraHeaders || {},
      ...(options.streamRes ? { res: options.streamRes, signal: options.signal } : {})
    });

    if (result.ok) {
      return {
        ok: true,
        data: result.data,
        fullContent: result.fullContent,
        // N'annonce un fallback que si le provider n'est PAS le premier de la chaîne
        modelUsed: i > 0 ? `${result.modelUsed} (${provider.name} fallback)` : result.modelUsed,
        fallbackUsed: i > 0,
        originalModel: providers[0].model,
        provider
      };
    }

    lastResult = result;

    // Client déconnecté (stream avorté) : on stoppe la chaîne silencieusement,
    // il n'y a plus personne à qui écrire une erreur.
    if (result.status === 499) {
      return { ok: false, status: 499, errText: "Requête annulée" };
    }

    // Erreur non-récupérable (401, 403, etc.) → stop immédiat
    // Un 404 (modèle non trouvé / déprécié) est au contraire récupérable :
    // on essaie le modèle suivant de la chaîne (ex: modèle OpenRouter déprécié).
    if (result.status !== 429 && result.status !== 404 && result.status < 500) {
      console.error(`Erreur ${provider.name}:`, result.errText);
      return { ok: false, status: result.status, errText: result.errText, provider };
    }

    // 429, 404 ou 5xx → continue vers le provider suivant
    console.warn(`${provider.name} ${result.status}, passage au suivant`);
  }

  // Tous les providers ont échoué
  return lastResult || { ok: false, status: 503, errText: "Aucun fournisseur disponible" };
}

/**
 * Appelle l'API avec fallback automatique (version non-streaming).
 * Maintient la compatibilité avec les appels existants.
 */
async function callOpenRouterWithFallback({ apiKey, model, messages, maxTokens, groqApiKey, customApiUrl, customApiKey, customApiModel, openaiApiKey }) {
  const settings = {
    apiKey, model, maxTokens,
    groqApiKey,
    customApiUrl, customApiKey, customApiModel,
    openaiApiKey
  };
  const providers = getFallbackProviders(settings);
  return await tryProviderChain(providers, apiCall, { messages, maxTokens });
}

// Historique de conversation en mémoire par session
// (pour la prod : remplacer par Redis ou une base de données)
const conversations = new Map();

// Marqueur de réinitialisation par session : permet aux réponses en cours
// (chat, stream, suggestions) de détecter qu'un « Réinitialiser la
// conversation » a eu lieu PENDANT leur exécution, et de ne PAS recréer
// l'historique / le cache que le reset vient d'effacer.
const sessionResetMarkers = new Map(); // sessionId -> timestamp du dernier reset

// Nettoie les conversations inactives toutes les 30 minutes
// (purge aussi les marqueurs de reset des mêmes sessions : sans ce nettoyage,
// sessionResetMarkers grossirait indéfiniment — fuite mémoire).
const CONVERSATION_TTL = 30 * 60 * 1000; // 30 minutes sans activité
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of conversations) {
    if (now - session.lastActivity > CONVERSATION_TTL) {
      conversations.delete(sessionId);
      sessionResetMarkers.delete(sessionId);
    }
  }
  // Purge aussi les marqueurs ORPHELINS : un « Réinitialiser la conversation »
  // peut poser un marqueur pour une session qui n'a (encore) aucune conversation
  // (ex. reset sur une session fraîche). Ces marqueurs n'ont plus de raison
  // d'être après le TTL et ne doivent pas s'accumuler.
  if (sessionResetMarkers.size > 0) {
    for (const [sessionId, markerTime] of sessionResetMarkers) {
      if (!conversations.has(sessionId) && now - markerTime > CONVERSATION_TTL) {
        sessionResetMarkers.delete(sessionId);
      }
    }
  }
}, 30 * 60 * 1000);

// ---------------------------------------------------------------------------
// Rate limiting pour les requêtes publiques d'Aïda afin d'éviter les abus
// ---------------------------------------------------------------------------
const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 300, // maximum de 300 requêtes par 15 minutes par adresse IP (~1 requête/3s)
  message: { error: "Trop de requêtes. Veuillez réessayer dans 15 minutes." },
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

// Limiteur DÉDIÉ aux suggestions de suivi : ne partage pas le quota du chat
// (sinon chaque échange consommerait 2 unités du même budget de 300/15 min).
const chatSuggestionsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  message: { error: "Trop de requêtes. Veuillez réessayer dans 15 minutes." },
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

// ---------------------------------------------------------------------------
// Middleware d'authentification admin — vérifie le mot de passe configuré.
// Sécurisé pour la production : vérifie que le mot de passe est défini.
// ---------------------------------------------------------------------------
function requireAdmin(req, res, next) {
  const provided = req.headers["x-admin-password"];
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || !provided || !safeEqual(provided, expected)) {
    return res.status(401).json({ error: "Non autorisé" });
  }
  next();
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 10, // maximum 10 tentatives par 15 minutes
  message: { error: "Trop de tentatives. Réessayez dans 15 minutes." },
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

// Anti-cache pour les données admin (évite les données obsolètes dans le cache navigateur)
app.use("/api/admin", (req, res, next) => {
  if (req.method === "GET") {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
  }
  next();
});

app.post("/api/admin/login", loginLimiter, (req, res) => {
  const { password } = req.body;
  if (process.env.ADMIN_PASSWORD && safeEqual(password, process.env.ADMIN_PASSWORD)) {
    return res.json({ ok: true });
  }
  res.status(401).json({ error: "Mot de passe incorrect" });
});

// ---------------------------------------------------------------------------
// Routes admin : paramètres du bot (dont la clé API)
// ---------------------------------------------------------------------------
app.get("/api/admin/settings", requireAdmin, (req, res) => {
  const settings = getSettings();
  // Masque les clés API (6 derniers caractères visibles)
  const maskKey = (key) => key
    ? "•".repeat(Math.max(key.length - 6, 0)) + key.slice(-6)
    : "";

  res.json({
    ...settings,
    apiKey: maskKey(settings.apiKey),
    hasApiKey: !!settings.apiKey,
    openaiApiKey: maskKey(settings.openaiApiKey),
    hasOpenAiApiKey: !!settings.openaiApiKey,
    groqApiKey: maskKey(settings.groqApiKey),
    hasGroqApiKey: !!settings.groqApiKey,

    customApiKey: maskKey(settings.customApiKey),
    hasCustomApiKey: !!settings.customApiKey,
    // État du stockage : l'admin affiche une bannière JUSTIFIÉE selon le cas
    // (stockage confirmé / premier démarrage / clés en variables d'env /
    // stockage éphémère) au lieu d'un simple binaire figé au démarrage.
    storagePersistent: isStoragePersistent(),
    storage: getStorageStatus()
  });
});

app.post("/api/admin/settings", requireAdmin, (req, res) => {
  const { apiKey, openaiApiKey, groqApiKey, customApiUrl, customApiKey, customApiModel, model, botName, welcomeMessage, systemPrompt, maxTokens, accentColor, accentColorDark, fontFamily, siteUrl, siteExploration, conversationalSuggestions } = req.body;

  // Construit le patch en ne conservant que les champs explicitement fournis
  const patch = {};

  // Champs texte : on ne met à jour que s'ils sont présents dans la requête
  if (model !== undefined) patch.model = model;
  if (botName !== undefined) patch.botName = botName;
  if (welcomeMessage !== undefined) patch.welcomeMessage = welcomeMessage;
  if (systemPrompt !== undefined) patch.systemPrompt = systemPrompt;
  if (accentColor !== undefined) patch.accentColor = accentColor;
  if (accentColorDark !== undefined) patch.accentColorDark = accentColorDark;
  if (fontFamily !== undefined) patch.fontFamily = fontFamily;
  // Exploration du site web (mode autonome)
  if (siteUrl !== undefined) patch.siteUrl = siteUrl;
  if (typeof siteExploration === "boolean") patch.siteExploration = siteExploration;
  // Suggestions dynamiques (régénérées selon la conversation en cours)
  if (typeof conversationalSuggestions === "boolean") patch.conversationalSuggestions = conversationalSuggestions;
  // customApiUrl et customApiModel : mise à jour uniquement si explicitement fournis
  // Permet de vider le champ ("") pour désactiver l'API personnalisée
  if (customApiUrl !== undefined) patch.customApiUrl = customApiUrl;
  if (customApiModel !== undefined) patch.customApiModel = customApiModel;

  // fontFamily : validation stricte pour éviter l'injection CSS
  // Seuls les caractères alphanumériques, espaces, tirets et virgules sont autorisés
  // Les guillemets sont supprimés car inutiles et dangereux dans le CSS inline
  if (fontFamily !== undefined) {
    const sanitized = fontFamily.replace(/['"]+/g, "").trim();
    if (sanitized && !/^[a-zA-Z0-9\s,\-]+$/.test(sanitized)) {
      return res.status(400).json({ error: "Nom de police invalide : seuls les caractères alphanumériques, espaces, tirets et virgules sont autorisés." });
    }
    patch.fontFamily = sanitized;
  }

  // maxTokens : validation stricte
  if (maxTokens !== undefined) {
    const parsed = parseInt(maxTokens, 10);
    if (isNaN(parsed) || parsed < 100 || parsed > 4000) {
      return res.status(400).json({ error: "maxTokens doit être un nombre entre 100 et 4000" });
    }
    patch.maxTokens = parsed;
  }

  // On ne remplace chaque clé API que si une nouvelle valeur non masquée est envoyée
  if (apiKey && !apiKey.includes("•")) patch.apiKey = apiKey;
  if (openaiApiKey && !openaiApiKey.includes("•")) patch.openaiApiKey = openaiApiKey;
  if (groqApiKey && !groqApiKey.includes("•")) patch.groqApiKey = groqApiKey;
  if (customApiKey && !customApiKey.includes("•")) patch.customApiKey = customApiKey;

  const updated = saveSettings(patch);
  // Marque l'instant de la sauvegarde : l'indicateur admin compte les widgets
  // qui reçoivent la nouvelle config À PARTIR de ce moment. Le journal est
  // purgé pour repartir de zéro (évite tout sous-comptage).
  lastConfigSaveTime = Date.now();
  configDeliveryLog.length = 0;
  res.json({ ok: true, settings: { ...updated, apiKey: undefined, openaiApiKey: undefined, groqApiKey: undefined, customApiKey: undefined } });
});

// ---------------------------------------------------------------------------
// Route admin : état de la propagation de la config vers les widgets
// L'indicateur du tableau de bord affiche combien de widgets ont reçu la
// nouvelle config depuis la dernière sauvegarde (et combien sont actifs).
// ---------------------------------------------------------------------------
app.get("/api/admin/widget-status", requireAdmin, (req, res) => {
  const now = Date.now();
  const sinceSave = lastConfigSaveTime
    ? configDeliveryLog.filter((d) => d.t >= lastConfigSaveTime)
    : [];
  const recentIps = new Set(
    configDeliveryLog.filter((d) => now - d.t < 5 * 60 * 1000).map((d) => d.ip)
  );
  res.json({
    configSavedAt: lastConfigSaveTime || null,
    deliveriesSinceSave: sinceSave.length,      // réceptions (un widget poll ~1/min)
    widgetsSinceSave: new Set(sinceSave.map((d) => d.ip)).size, // widgets distincts
    activeWidgets5m: recentIps.size
  });
});

// ---------------------------------------------------------------------------
// Route admin : test de connexion à l'API OpenRouter
// ---------------------------------------------------------------------------
app.post("/api/admin/test-connection", requireAdmin, async (req, res) => {
  try {
    const { apiKey, model } = req.body;

    // Récupère les settings
    const settings = getSettings();
    
    // Utilise la clé fournie ou celle enregistrée (pour chaque provider)
    const testOpenRouterKey = apiKey || settings.apiKey;
    const testModel = model || settings.model || "openrouter/free";

    // Vérifie qu'au moins une clé est fournie (OpenRouter ou un fallback)
    const hasAnyKey = testOpenRouterKey ||
      (req.body.groqApiKey || settings.groqApiKey) ||
      (req.body.openaiApiKey || settings.openaiApiKey) ||
      (req.body.customApiKey || settings.customApiKey);

    if (!hasAnyKey) {
      return res.json({ ok: false, error: "Aucune clé API fournie. Configure au moins un fournisseur (OpenRouter, Groq, OpenAI...)." });
    }

    const openAiKey = req.body.openaiApiKey || settings.openaiApiKey;
    const groqKey = req.body.groqApiKey || settings.groqApiKey;
    const customUrl = req.body.customApiUrl || settings.customApiUrl;
    const customKey = req.body.customApiKey || settings.customApiKey;
    const customModel = req.body.customApiModel || settings.customApiModel || "llama3.1-8b";

    const result = await callOpenRouterWithFallback({
      apiKey: testOpenRouterKey,
      model: testModel,
      messages: [
        { role: "user", content: "Test de connexion — réponds uniquement \"OK\"." }
      ],
      maxTokens: 10,
      groqApiKey: groqKey,
      customApiUrl: customUrl,
      customApiKey: customKey,
      customApiModel: customModel,
      openaiApiKey: openAiKey
    });

    if (result.ok) {
      const reply = result.data.choices?.[0]?.message?.content || "";
      const modelUsed = result.modelUsed || testModel;
      res.json({
        ok: true,
        message: `Connexion réussie avec ${modelUsed}${result.fallbackUsed ? ` (fallback depuis ${result.originalModel})` : ""}`,
        model: modelUsed,
        fallbackUsed: result.fallbackUsed,
        originalModel: result.originalModel,
        reply: reply.trim()
      });
    } else {
      const errText = result.errText;
      let detail = "";
      let fullDetail = "";
      try {
        const errJson = JSON.parse(errText);
        // OpenRouter emboîte souvent l'erreur réelle du provider
        const rawMeta = errJson.error?.metadata?.raw;
        const rawMsg =
          rawMeta?.error?.message ||
          (typeof rawMeta === "string" ? rawMeta : null);
        detail = rawMsg || errJson.error?.message || errJson.error?.code || errText;
        fullDetail = rawMsg ? errJson.error?.message + " : " + rawMsg : detail;
        // Pour les erreurs 401 (clé manquante ou invalide), on fournit un message clair
        if (result.status === 401) {
          detail = `Clé API invalide ou manquante pour « ${result.provider?.name || "ce fournisseur"} ». Vérifie la configuration dans /admin.`;
          fullDetail = errText;
        }
      } catch {
        detail = errText;
        fullDetail = errText;
      }
      res.json({
        ok: false,
        error: detail,
        fullError: fullDetail,
        status: result.status
      });
    }
  } catch (err) {
    console.error("Erreur test connexion:", err);
    res.json({ ok: false, error: err.message || "Erreur réseau" });
  }
});

// ---------------------------------------------------------------------------
// Routes admin : documents de contexte (base de connaissances / RAG)
// ---------------------------------------------------------------------------
app.get("/api/admin/documents", requireAdmin, (req, res) => {
  const docs = getDocuments().map(({ id, title, addedAt, content }) => ({
    id,
    title,
    addedAt,
    preview: content.slice(0, 140) + (content.length > 140 ? "…" : ""),
    length: content.length
  }));
  res.json({ documents: docs });
});

app.post("/api/admin/documents", requireAdmin, async (req, res) => {
  try {
    const { title, content } = req.body;
    if (!content || !content.trim()) {
      return res.status(400).json({ error: "Le contenu du document est requis" });
    }
    const doc = await addDocument({ title, content });
    res.json({ ok: true, document: { id: doc.id, title: doc.title, addedAt: doc.addedAt } });
  } catch (err) {
    console.error("Erreur ajout document:", err);
    res.status(500).json({ error: "Erreur lors de l'ajout du document" });
  }
});

app.post("/api/admin/documents/upload", requireAdmin, async (req, res) => {
  try {
    const { filename, base64Data } = req.body;
    if (!filename || !base64Data) {
      return res.status(400).json({ error: "Nom de fichier ou données manquants" });
    }

    // Limite de taille : 10 Mo après décodage base64
    const MAX_SIZE = 10 * 1024 * 1024; // 10 Mo
    const base64Content = base64Data.includes("base64,")
      ? base64Data.split("base64,")[1]
      : base64Data;

    // Estimation de la taille avant décodage (base64 → binaire ≈ ratio 4:3)
    const decodedSize = Math.ceil(base64Content.length * 0.75);
    if (decodedSize > MAX_SIZE) {
      return res.status(400).json({
        error: `Le fichier est trop volumineux (max ${(MAX_SIZE / 1024 / 1024).toFixed(0)} Mo).`
      });
    }

    // ── Validation du type MIME ────────────────────────────────────────
    // 1) Vérifie le préfixe data URL s'il est présent
    const mimeMatch = base64Data.match(/^data:([^;]+);base64,/);
    if (mimeMatch) {
      const mime = mimeMatch[1].toLowerCase();
      if (mime !== "application/pdf") {
        return res.status(400).json({
          error: `Type de fichier non supporté : "${mime}". Seuls les PDF sont acceptés.`
        });
      }
    }

    // 2) Vérifie le nom du fichier
    if (!filename.toLowerCase().endsWith(".pdf")) {
      return res.status(400).json({
        error: "Seuls les fichiers PDF sont acceptés (extension .pdf)."
      });
    }

    const buffer = Buffer.from(base64Content, "base64");

    // 3) Vérifie les magic bytes du PDF (%PDF en début de fichier)
    const pdfHeader = buffer.slice(0, 5).toString("ascii");
    if (pdfHeader !== "%PDF-") {
      return res.status(400).json({
        error: "Le fichier n'est pas un PDF valide (signature %PDF introuvable)."
      });
    }

    const parser = new PDFParse({
      data: buffer,
      verbosity: 0 // VerbosityLevel.ERRORS
    });
    await parser.load();
    const pdfData = await parser.getText();
    let text = pdfData.text || "";

    text = text
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    if (!text) {
      return res.status(400).json({
        error: "Impossible d'extraire du texte de ce PDF. Vérifiez qu'il ne s'agit pas d'une image numérisée sans OCR."
      });
    }

    const doc = await addDocument({ title: filename, content: text });

    res.json({ ok: true, document: { id: doc.id, title: doc.title, addedAt: doc.addedAt } });
  } catch (err) {
    console.error("Erreur lors de l'ingestion du PDF:", err);
    res.status(500).json({ error: "Erreur lors de la lecture du fichier PDF" });
  }
});

app.delete("/api/admin/documents/:id", requireAdmin, (req, res) => {
  deleteDocument(req.params.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Route publique : chat (utilisée par le widget) avec rate limiter
// Gère explicitement le preflight CORS OPTIONS — indispensable quand le widget
// est chargé depuis un domaine différent (le site du client). Sans ce handler,
// le navigateur bloque les requêtes POST avec Content-Type: application/json.
// ---------------------------------------------------------------------------
app.options("/api/chat", widgetCors);
app.post("/api/chat", widgetCors, chatLimiter, async (req, res) => {
  try {
    const { message, sessionId, siteUrl } = req.body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message manquant" });
    }
    // Validation : limite de taille du message
    if (message.length > 4000) {
      return res.status(400).json({ error: "Message trop long (maximum 4000 caractères)." });
    }

    // Génère un sessionId par défaut si non fourni (évite le partage d'historique)
    const effectiveSessionId = sessionId || "anon-" + crypto.randomUUID();

    const settings = getSettings();
    // Vérifie qu'au moins UNE clé API est configurée (OpenRouter ou fallbacks)
    if (!settings.apiKey && !settings.groqApiKey && !settings.customApiUrl && !settings.openaiApiKey) {
      return res.status(400).json({
        error: "Aucune clé API configurée. Va dans /admin pour en ajouter une."
      });
    }
    // Vérifie qu'au moins un fournisseur est réellement utilisable
    // (ex : une API distante sans clé API est ignorée → aucune requête possible)
    if (getFallbackProviders(settings).length === 0) {
      return res.status(400).json({
        error: "Aucun fournisseur utilisable : ajoute une clé API (OpenRouter, Groq, OpenAI) ou la clé de ton API personnalisée dans /admin."
      });
    }

    // 1. Contexte pertinent (RAG vectoriel + mots-clés + exploration du site)
    //    Pour un simple « Bonjour » ou un message de politesse, on ne charge
    //    AUCUN contexte : l'IA répond chaleureusement et engage la discussion
    //    (évite le pitch de solutions immédiat et l'exploration inutile du site).
    const conversational = isConversationalMessage(message);
    let contextBlock = "";
    let relevantChunks = [];
    let usedVectorSearch = false;
    let siteExplored = false;
    let queryEmbedding = null;
    if (!conversational) {
      const { documents, chunkEntries, chunkIndex } = getRagContext();
      queryEmbedding = chunkEntries.length > 0 && chunkEntries.some(e => e.embedding)
        ? await generateEmbedding(message).catch(() => null)
        : null;
      if (queryEmbedding) {
        relevantChunks = findSimilarChunks(queryEmbedding, chunkEntries, 4);
        usedVectorSearch = relevantChunks.length > 0;
      }
      if (relevantChunks.length === 0) {
        relevantChunks = retrieveRelevantChunksSync(documents, message, 4, chunkIndex);
      }
      contextBlock = buildContextBlock(relevantChunks);

      // ⚡ Mode autonome : si le contexte RAG est insuffisant, explore le site web
      if (!isContextSufficient(relevantChunks, usedVectorSearch)) {
        const siteBlock = await getSiteContextBlock(settings, siteUrl, message);
        if (siteBlock) {
          contextBlock += siteBlock;
          siteExplored = true;
        }
      }
    }

    // 2. Historique (copie pour éviter toute mutation de l'objet en cache)
    // Marqueur anti-race : si un reset survient pendant l'appel LLM, on ne
    // recrée pas l'historique que le reset vient d'effacer.
    const resetMarkerAtStart = sessionResetMarkers.get(effectiveSessionId) || 0;
    const previous = conversations.get(effectiveSessionId);
    const previousHistory = previous ? previous.history : [];

    // 2bis. Changement de sujet : si le visiteur change totalement de sujet
    // (ex. : du cloud au développement web), on RÉINITIALISE l'historique pour
    // que l'IA s'adapte immédiatement, sans être polluée par les échanges
    // précédents. Le contexte RAG reste celui de la question la plus récente.
    let topicShifted = false;
    let history;
    if (previousHistory.length > 0 && !conversational) {
      topicShifted = await detectTopicShift(message, previousHistory, queryEmbedding);
      history = topicShifted
        ? [{ role: "user", content: message }]
        : [...previousHistory, { role: "user", content: message }];
      if (topicShifted) {
        console.log(`🔄 Changement de sujet détecté (session ${effectiveSessionId.slice(0, 12)}…) — historique réinitialisé`);
      }
    } else {
      history = [...previousHistory, { role: "user", content: message }];
    }

    // 3. Appel à l'API OpenRouter (compatible OpenAI)
    // Si un changement de sujet a été détecté, on ajoute une consigne explicite
    // pour que l'IA réponde à la nouvelle question sans référence à l'ancien sujet.
    const systemContent =
      (settings.systemPrompt || "") + contextBlock +
      (topicShifted ? TOPIC_SHIFT_SYSTEM_NOTE : FOLLOW_LATEST_QUESTION_NOTE);
    const messages = [
      { role: "system", content: systemContent },
      ...history
    ];

    const result = await callOpenRouterWithFallback({
      apiKey: settings.apiKey,
      model: settings.model || "openrouter/free",
      messages,
      maxTokens: settings.maxTokens || 800,
      groqApiKey: settings.groqApiKey,
      customApiUrl: settings.customApiUrl,
      customApiKey: settings.customApiKey,
      customApiModel: settings.customApiModel,
      openaiApiKey: settings.openaiApiKey
    });

    if (!result.ok) {
      const errText = result.errText;
      console.error("Erreur API IA:", errText);
      let detail = "Erreur du service IA.";
      try {
        const errJson = JSON.parse(errText);
        detail = errJson.error?.message || errJson.error || detail;
      } catch {}

      let userMessage;
      if (result.status === 429) {
        userMessage = `Erreur IA : tous les fournisseurs sont saturés (429). Réessaie dans quelques instants ou configure une clé de fallback.`;
      } else if (result.status === 404) {
        userMessage = `Erreur IA : le modèle configuré n'est plus disponible (404). Change-le dans /admin.`;
      } else if (result.status === 401 || result.status === 403) {
        userMessage = `Erreur IA : clé API invalide ou manquante pour ${result.provider?.name || "le fournisseur"}. Vérifie-la dans /admin.`;
      } else {
        userMessage = `Erreur IA : ${detail}${result.status >= 500 ? ' (le fournisseur est peut-être temporairement indisponible)' : ''}`;
      }
      return res.status(502).json({ error: userMessage });
    }

    const rawReply = result.data.choices?.[0]?.message?.content || "Désolé, je n'ai pas compris.";
    let reply = filterAIContent(rawReply);
    reply = await correctText(reply);
    reply = normalizeSpacing(reply);

    // Sauvegarde de la conversation uniquement en cas de succès de l'appel.
    // (Sauf si un reset est survenu pendant l'appel : l'historique reste vide.)
    if (sessionResetMarkers.get(effectiveSessionId) === resetMarkerAtStart) {
      const updatedHistory = [...history, { role: "assistant", content: reply }];
      conversations.set(effectiveSessionId, { history: updatedHistory.slice(-HISTORY_MAX_TURNS), lastActivity: Date.now() });
    }

    res.json({
      reply,
      sourcesUsed: relevantChunks.map((r) => r.title),
      siteExplored,
      fallbackUsed: result.fallbackUsed,
      modelUsed: result.modelUsed
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ---------------------------------------------------------------------------
// Route publique : chat en streaming (SSE) — temps réel, ultra-rapide
// Utilise la même logique que /api/chat mais envoie chaque token au fur et à mesure.
// ---------------------------------------------------------------------------
app.options("/api/chat/stream", widgetCors);
app.post("/api/chat/stream", widgetCors, chatLimiter, async (req, res) => {
  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  let responseEnded = false;

  // Ne tente jamais d'écrire sur un socket fermé (client déconnecté) : évite
  // les erreurs ERR_STREAM_WRITE_AFTER_END et les logs parasites.
  res.on("error", () => {});
  const safeWrite = (payload) => {
    if (responseEnded || res.writableEnded || res.destroyed) return;
    try { res.write(payload); } catch { /* socket fermé */ }
  };
  const safeEnd = () => {
    // NB : ne PAS tester `responseEnded` ici. Tous les appels placent
    // `responseEnded = true` AVANT d'appeler safeEnd() : si ce flag était
    // testé, res.end() ne serait JAMAIS appelé et la réponse SSE resterait
    // ouverte indéfiniment — le widget attendrait la fin du flux pour
    // réactiver la zone de saisie (blocage total après la 1ère question).
    if (res.writableEnded || res.destroyed) return;
    try { res.end(); } catch { /* socket fermé */ }
  };

  try {
    const { message, sessionId, siteUrl } = req.body;
    if (!message || typeof message !== "string") {
      safeWrite(`data: ${JSON.stringify({ error: "Message manquant" })}\n\n`);
      responseEnded = true;
      return safeEnd();
    }
    if (message.length > 4000) {
      safeWrite(`data: ${JSON.stringify({ error: "Message trop long (maximum 4000 caractères)." })}\n\n`);
      responseEnded = true;
      return safeEnd();
    }

    const effectiveSessionId = sessionId || "anon-" + crypto.randomUUID();
    const settings = getSettings();

    // Vérifie qu'au moins UNE clé API est configurée
    if (!settings.apiKey && !settings.groqApiKey && !settings.customApiUrl && !settings.openaiApiKey) {
      safeWrite(`data: ${JSON.stringify({ error: "Aucune clé API configurée" })}\n\n`);
      responseEnded = true;
      return safeEnd();
    }
    // Vérifie qu'au moins un fournisseur est réellement utilisable
    if (getFallbackProviders(settings).length === 0) {
      safeWrite(`data: ${JSON.stringify({ error: "Aucun fournisseur utilisable : ajoute une clé API dans /admin." })}\n\n`);
      responseEnded = true;
      return safeEnd();
    }

    // 1. Contexte pertinent (RAG vectoriel + mots-clés + exploration du site)
    //    Pour un simple « Bonjour » ou un message de politesse, on ne charge
    //    AUCUN contexte : l'IA répond chaleureusement et engage la discussion
    //    (évite le pitch de solutions immédiat et l'exploration inutile du site).
    const conversational = isConversationalMessage(message);
    let contextBlock = "";
    let relevantChunks = [];
    let usedVectorSearch = false;
    let siteExplored = false;
    let queryEmbedding = null;
    if (!conversational) {
      const { documents, chunkEntries, chunkIndex } = getRagContext();
      queryEmbedding = chunkEntries.length > 0 && chunkEntries.some(e => e.embedding)
        ? await generateEmbedding(message).catch(() => null)
        : null;
      if (queryEmbedding) {
        relevantChunks = findSimilarChunks(queryEmbedding, chunkEntries, 4);
        usedVectorSearch = relevantChunks.length > 0;
      }
      if (relevantChunks.length === 0) {
        relevantChunks = retrieveRelevantChunksSync(documents, message, 4, chunkIndex);
      }
      contextBlock = buildContextBlock(relevantChunks);

      // ⚡ Mode autonome : si le contexte RAG est insuffisant, explore le site web
      if (!isContextSufficient(relevantChunks, usedVectorSearch)) {
        const siteBlock = await getSiteContextBlock(settings, siteUrl, message);
        if (siteBlock) {
          contextBlock += siteBlock;
          siteExplored = true;
        }
      }
    }

    // 2. Historique (copie pour éviter toute mutation de l'objet en cache)
    // Marqueur anti-race : si un reset survient pendant l'appel LLM, on ne
    // recrée pas l'historique que le reset vient d'effacer.
    const resetMarkerAtStart = sessionResetMarkers.get(effectiveSessionId) || 0;
    const previous = conversations.get(effectiveSessionId);
    const previousHistory = previous ? previous.history : [];

    // 2bis. Changement de sujet : si le visiteur change totalement de sujet
    // (ex. : du cloud au développement web), on RÉINITIALISE l'historique pour
    // que l'IA s'adapte immédiatement, sans être polluée par les échanges
    // précédents. Le contexte RAG reste celui de la question la plus récente.
    let topicShifted = false;
    let history;
    if (previousHistory.length > 0 && !conversational) {
      topicShifted = await detectTopicShift(message, previousHistory, queryEmbedding);
      history = topicShifted
        ? [{ role: "user", content: message }]
        : [...previousHistory, { role: "user", content: message }];
      if (topicShifted) {
        console.log(`🔄 Changement de sujet détecté (session ${effectiveSessionId.slice(0, 12)}…) — historique réinitialisé`);
      }
    } else {
      history = [...previousHistory, { role: "user", content: message }];
    }

    // 3. Messages pour l'API
    // Si un changement de sujet a été détecté, on ajoute une consigne explicite
    // pour que l'IA réponde à la nouvelle question sans référence à l'ancien sujet.
    const systemContent =
      (settings.systemPrompt || "") + contextBlock +
      (topicShifted ? TOPIC_SHIFT_SYSTEM_NOTE : FOLLOW_LATEST_QUESTION_NOTE);
    const messages = [
      { role: "system", content: systemContent },
      ...history
    ];

    // 4. Chaîne de fallback via la fonction partagée
    const abortController = new AbortController();
    // Si le client ferme la connexion (on quitte la page, on ferme le chat…),
    // on annule immédiatement l'appel upstream : plus de tokens gaspillés,
    // plus de socket bloqué jusqu'au timeout.
    // NB : on écoute 'close' sur la RÉPONSE, PAS sur req — depuis Node 16,
    // req émet 'close' dès que le corps est lu (donc immédiatement), ce qui
    // annulerait le stream avant même le premier token. res 'close' n'arrive,
    // lui, qu'à la fermeture réelle du socket (client parti) ou après res.end().
    // Garde avec notre flag responseEnded (pas res.destroyed : ce dernier est
    // mis à true dès que le socket du client est fermé, ce qui bloquerait
    // l'abort au moment même où il faut annuler l'appel upstream).
    const onClientClose = () => {
      if (!responseEnded) abortController.abort();
    };
    res.on("close", onClientClose);
    const providers = getFallbackProviders(settings);

    const streamResult = await tryProviderChain(providers, (opts) => apiCallStream({ ...opts, res, signal: abortController.signal }), {
      messages,
      maxTokens: settings.maxTokens || 800
    });

    if (!streamResult.ok) {
      // Si le client est déjà parti, inutile d'écrire l'erreur
      if (res.destroyed || res.writableEnded) return;
      const errStatus = streamResult.status;
      let errMsg;
      if (errStatus === 499) {
        // Provider muet (watchdog d'oisiveté) : le client est toujours connecté,
        // on lui explique que le fournisseur n'a pas répondu, pas qu'il y a un
        // problème de configuration.
        errMsg = "Le fournisseur IA n'a pas répondu. Réessaie dans quelques instants.";
      } else if (errStatus === 401 || errStatus === 403) {
        const errProvider = streamResult.provider?.name || "l'assistant";
        const errProviderLabel = /^[aeiouyàâäéèêëîïôöùûü]/i.test(errProvider) ? `d'${errProvider}` : `de ${errProvider}`;
        errMsg = `La clé API ${errProviderLabel} est invalide ou manquante. Vérifie-la dans /admin.`;
      } else if (errStatus === 404) {
        errMsg = "Le modèle configuré n'est plus disponible (404). Change-le dans /admin.";
      } else if (errStatus === 429) {
        errMsg = "Tous les fournisseurs sont saturés (429). Réessaie dans quelques instants.";
      } else if (errStatus >= 500) {
        errMsg = "Les fournisseurs IA sont temporairement indisponibles. Réessaie plus tard.";
      } else {
        errMsg = "Erreur de connexion aux fournisseurs IA. Vérifie ta configuration dans /admin.";
      }
      safeWrite(`data: ${JSON.stringify({ error: errMsg })}\n\n`);
      responseEnded = true;
      return safeEnd();
    }

    // Sauvegarde de la conversation — uniquement si aucun reset n'a eu lieu
    // pendant le stream (sinon l'historique doit rester vide).
    const rawReply = streamResult.fullContent || ""; // déjà filtré par apiCallStream
    const fullReply = normalizeSpacing(await correctText(rawReply));
    if (sessionResetMarkers.get(effectiveSessionId) === resetMarkerAtStart) {
      const updatedHistory = [...history, { role: "assistant", content: fullReply }];
      conversations.set(effectiveSessionId, { history: updatedHistory.slice(-HISTORY_MAX_TURNS), lastActivity: Date.now() });
    }

    // Signal de fin avec métadonnées
    safeWrite(`data: ${JSON.stringify({ done: true, fullContent: fullReply, modelUsed: streamResult.modelUsed, fallbackUsed: streamResult.fallbackUsed, sourcesUsed: relevantChunks.map(r => r.title), siteExplored })}\n\n`);
    responseEnded = true;
    safeEnd();
  } catch (err) {
    console.error("Erreur streaming:", err);
    if (!responseEnded) {
      safeWrite(`data: ${JSON.stringify({ error: "Erreur serveur" })}\n\n`);
      responseEnded = true;
      safeEnd();
    }
  }
});

// ---------------------------------------------------------------------------
// Route publique : réinitialisation de la conversation (bouton du widget)
// Efface l'historique de session côté serveur pour repartir de zéro, ainsi
// que les suggestions conversationnelles en cache de cette session.
// ---------------------------------------------------------------------------
app.options("/api/chat/reset", widgetCors);
app.post("/api/chat/reset", widgetCors, chatLimiter, (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "sessionId manquant" });
  }

  conversations.delete(sessionId);
  // Marque le reset : toute réponse déjà en vol pour cette session (chat,
  // stream, suggestions) détectera le changement et n'écrira pas.
  sessionResetMarkers.set(sessionId, Date.now());

  // Purge les suggestions DE SUIVI mises en cache pour cette session : après
  // la réinitialisation, un ancien échange ne doit plus pouvoir ressortir ses
  // questions de suivi.
  const prefix = sessionId + ":";
  for (const key of conversationSuggestionsCache.keys()) {
    if (key.startsWith(prefix)) conversationSuggestionsCache.delete(key);
  }
  for (const key of convSuggestionsInFlight.keys()) {
    if (key.startsWith(prefix)) convSuggestionsInFlight.delete(key);
  }

  res.json({ ok: true });
});

// Health check pour monitoring / load balancer
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    version: "1.0.0",
    embedding: typeof ensureEmbeddingModel === "function" // vérifie que le module est accessible
  });
});

// Keep-alive dédié (anti-veille) : réponse VIDE (204) sans aucun calcul ni
// JSON — le plus léger possible. Réservé au self-ping du serveur lui-même
// (et à un éventuel moniteur externe). /api/health reste le health check
// « riche » pour l'infra (load balancer, healthcheck Docker/Render).
const KEEPALIVE_PATH = "/api/keepalive"; // partagé avec le self-ping anti-veille
app.get(KEEPALIVE_PATH, (req, res) => {
  res.status(204).end();
});

// ─── Suivi de la propagation de la config vers les widgets ─────────────
// Les widgets rechargent /api/widget-config toutes les ~60 s (cache-busting).
// On note chaque réception pour que l'admin puisse confirmer visuellement que
// la nouvelle config a bien été reçue par des widgets connectés.
let lastConfigSaveTime = 0;
const configDeliveryLog = []; // [{ t: timestamp, ip }]
const CONFIG_DELIVERY_MAX = 500;

function recordWidgetConfigDelivery(req) {
  const now = Date.now();
  // IP HACHÉE (vie privée) : seuls des compteurs sont exposés côté admin,
  // jamais l'adresse brute du visiteur.
  configDeliveryLog.push({ t: now, ip: shortHash(req.ip || "inconnu") });
  while (configDeliveryLog.length > CONFIG_DELIVERY_MAX) configDeliveryLog.shift();
}

// Le widget lit ces infos publiques (nom du bot, message d'accueil) au chargement.
// Cache COURT (60 s) + ETag : après un changement dans l'admin, la nouvelle
// config (dont le toggle des suggestions dynamiques) se propage en ~1 minute
// au lieu de 5. Le widget force en plus le cache-busting (?v=Date.now()) à
// chaque rechargement périodique.
app.get("/api/widget-config", widgetCors, (req, res) => {
  recordWidgetConfigDelivery(req);
  const settings = getSettings();
  const config = {
    botName: settings.botName,
    welcomeMessage: settings.welcomeMessage,
    accentColor: settings.accentColor || "#2f6fed",
    accentColorDark: settings.accentColorDark || "#1f4fb8",
    fontFamily: settings.fontFamily || "system-ui",
    // Permet au widget d'éviter l'appel /api/chat/suggestions quand l'option
    // est désactivée dans l'admin (économie d'une requête par réponse).
    conversationalSuggestions: settings.conversationalSuggestions !== false
  };
  // Signature de la config : le widget la compare pour ne réappliquer les
  // réglages que lorsque l'admin a réellement modifié quelque chose.
  const signature = shortHash(JSON.stringify(config));
  const etag = `"${signature}"`;
  res.set("Cache-Control", "public, max-age=60, must-revalidate");
  res.set("ETag", etag);
  if (req.headers["if-none-match"] === etag) {
    return res.status(304).end();
  }
  res.json({ ...config, configSignature: signature });
});

// ─── Exploration autonome du site web ────────────────────────────────────
// Quand le contexte RAG est insuffisant pour répondre, on explore le site du
// client (celui où le widget est intégré) et on injecte les passages trouvés
// dans le system prompt. Le site est crawlée une fois puis mis en cache.

/**
 * Détecte les messages purement conversationnels (salutations, politesse,
 * small talk) pour lesquels on ne charge pas de contexte RAG et on n'explore
 * pas le site : un simple « Bonjour » ne doit pas déclencher un pitch de
 * solutions, mais une réponse chaleureuse qui engage la discussion.
 */
function isConversationalMessage(message) {
  const m = String(message || "")
    .trim()
    .toLowerCase()
    .replace(/[’']/g, "'"); // normalise les apostrophes (typographique vs droite)
  if (!m) return true;

  const greeting = /\b(bonjour|bonsoir|salut|coucou|hello|hi|hey|yo|hola|rebonjour)\b/;
  const smallTalk = /\b(merci|d'accord|daccord|ok|ça va|ca va|comment vas|comment allez|super|g[eé]nial|parfait|bien re[cç]u|a bient[oô]t|au revoir|bonne journ[eé]e)\b/;
  // Toute trace d'une vraie demande — même polie (« Merci de… ») ou implicite
  // (« Je veux savoir… », « Dites-moi… ») — doit être traitée avec le contexte.
  // NB : \bo[uù] (avec limites de mot) et non « o[uù] » : sans les bornes, le
  // « ou » de « bonjour », « beaucoup » ou « pour » serait pris pour le mot
  // interrogatif « où », et toutes les salutations seraient mal classées.
  const hasQuestionOrRequest = /\?|combien|quel|quelle|quels|quelles|comment|\bo[uù]|quand|pourquoi|qui |que |qu'est|qu’est|pouvez|pourriez|disponib|propos|proposez|tarif|prix|co[uû]t|aide|besoin|je voudrais|j'aimerais|je cherche|je souhaite|int[eé]ress|je veux|savoir|horaires|d'ouverture|ouvrez|dites-moi|dis-moi|indiquez|renseignez|pr[eé]cisez|envoyer|brochure|document|devis|rendez-vous|inscrire|commander|acheter|merci de|merci d'/.test(m);

  if (hasQuestionOrRequest) return false;

  // Un pur échange social (« Bonjour », « Merci ») est presque toujours bref :
  // on limite le classement « conversationnel » aux messages courts pour ne
  // jamais sauter le contexte sur une longue demande rédigée familièrement.
  if (m.length > 50) return false;

  return greeting.test(m) || smallTalk.test(m);
}

// ---------------------------------------------------------------------------
// Changement de sujet dans la conversation
// ---------------------------------------------------------------------------
// Le visiteur doit pouvoir changer totalement de sujet en cours de route
// (ex. : passer du cloud au développement web) sans que l'IA reste bloquée
// sur l'ancien thème. Quand un changement de sujet est détecté, l'historique
// de la session est réinitialisé et l'IA reçoit une consigne explicite de
// répondre à la nouvelle question sans référence aux échanges précédents.
// NB : les seuils sont calibrés sur le modèle d'embeddings actuel
// (@huggingface/transformers, multilingue). Si le modèle change, recalibrer.
const TOPIC_SIMILARITY_THRESHOLD = 0.50; // en dessous → sujets différents
// Quand l'utilisateur dirige EXPLICITEMENT la conversation (« parlons de… »,
// « autre chose : … »), on lui fait confiance : seul un sujet manifestement
// identique (similarité ≥ 0.65, ex. « Parlons de vos tarifs en détail » juste
// après « Quels sont vos tarifs ? ») est traité comme une continuation.
const TOPIC_EXPLICIT_HINT_THRESHOLD = 0.65;
const HISTORY_MAX_TURNS = 12; // fenêtre d'historique envoyée au modèle (avant : 20)

// Ouvertures qui marquent une CONTINUATION de la discussion (suivi, précision,
// rebond) : elles ne doivent JAMAIS être considérées comme un changement de sujet,
// même si la similarité sémantique est faible (« Et pour un gros volume ? », …).
const CONTINUATION_PREFIX = /^(et|et\s+si|et\s+pour|et\s+comment|et\s+avec|aussi|ensuite|sinon|d'ailleurs|d'accord|du\s+coup|en\s+fait|puis|et\s+en\s+plus|et\s+aussi)\b/i;

// Formulations qui annoncent explicitement un changement de sujet
const TOPIC_SHIFT_HINTS = [
  /\bchange(?:ons|z|r)?\s+de\s+sujet\b/i,
  /\bautre\s+sujet\b/i,
  /\bpassons\s+(?:à|a)\s+autre\s+chose\b/i,
  /^autre\s+chose\b|autre\s+chose\s*[:.]/i,
  /\b(?:parlons|parlions|parler|discutons)\s+(?:maintenant|plutôt)?\s*(?:de|du|d')/i,
  /\b(?:abordons|évoquons)\b/i,
  /\bnouvelle\s+question\b/i,
  /\bsans\s+rapport\b/i,
  /\bhors\s+sujet\b/i,
  /\b(?:j'aimerais|je\s+voudrais|je\s+veux)\s+(?:parler|aborder|poser\s+une\s+question)\s+de\b/i,
  /\btotalement\s+diff[ée]rent\b/i,
  /\bquestion\s+(?:totalement|compl[èe]tement)\s+diff[ée]rente\b/i
];

function hasExplicitTopicShiftHint(message) {
  const m = String(message || "").toLowerCase();
  return TOPIC_SHIFT_HINTS.some((re) => re.test(m));
}

// Mots-outils français exclus de la comparaison lexicale de repli
const FRENCH_STOPWORDS = new Set([
  "le", "la", "les", "un", "une", "des", "de", "du", "d", "et", "ou", "mais",
  "donc", "or", "ni", "car", "pour", "avec", "dans", "sur", "sous", "que",
  "qui", "quoi", "dont", "comment", "pourquoi", "quel", "quelle", "quels",
  "quelles", "est", "sont", "etre", "vous", "votre", "vos", "nos",
  "notre", "je", "tu", "il", "elle", "on", "nous", "ce", "cette", "ces",
  "au", "aux", "en", "par", "plus", "moins", "tres", "bien", "pas", "ca",
  "cela", "a", "à", "se", "sa", "son", "mes", "tes", "ses", "tout", "toute",
  "tous", "toutes", "faire", "fait", "peut", "peuvent", "avoir", "chez", "vers"
]);

/**
 * Repli lexical quand les embeddings sont indisponibles : deux messages qui ne
 * partagent aucun mot significatif sont considérés comme des sujets différents.
 */
function lexicalOverlapIsLow(a, b) {
  const tokens = (s) => {
    const words = String(s).toLowerCase().replace(/[’']/g, "'").match(/[a-zàâäéèêëîïôöùûüç]+/g) || [];
    return new Set(words.filter((w) => w.length > 2 && !FRENCH_STOPWORDS.has(w)));
  };
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  const union = ta.size + tb.size - inter;
  return union > 0 && inter / union < 0.12;
}

/**
 * Détecte si le nouveau message du visiteur marque un changement total de sujet
 * par rapport à la conversation en cours. Stratégies complémentaires :
 *   1. signal explicite ("changeons de sujet", "passons à autre chose"…) ;
 *   2. comparaison sémantique par embeddings (nouveau message vs dernier
 *      message utilisateur ET dernière réponse) ;
 *   3. repli lexical si les embeddings sont indisponibles.
 *
 * Retourne true si le visiteur a manifestement changé de sujet.
 */
async function detectTopicShift(message, previousHistory, precomputedEmbedding = null) {
  if (!message || !previousHistory || previousHistory.length === 0) return false;
  const userMsgs = previousHistory.filter((m) => m.role === "user");
  const explicitHint = hasExplicitTopicShiftHint(message);

  // Un signal explicite (« parlons de… », « autre chose : … ») peut être évalué
  // dès le premier échange ; sinon il faut au moins 2 messages utilisateur pour
  // comparer les sujets (évite de déclarer un changement sur la 1re vraie
  // question après une salutation).
  if (userMsgs.length < (explicitHint ? 1 : 2)) return false;

  const lastUserMsg = userMsgs[userMsgs.length - 1].content || "";
  const lastAssistant = [...previousHistory].reverse().find((m) => m.role === "assistant");
  const lastAssistantMsg = lastAssistant ? lastAssistant.content || "" : "";

  try {
    // Réutilise l'embedding déjà calculé par le RAG quand il existe
    // (économie d'une génération par message)
    const embNew = precomputedEmbedding || (await generateEmbedding(message));
    let simUser = null;
    let simAssistant = null;
    if (embNew) {
      const embUser = await generateEmbedding(lastUserMsg);
      if (embUser) simUser = cosineSimilarity(embNew, embUser);
    }

    if (explicitHint) {
      // Signal explicite : on y fait confiance, SAUF si le message reste
      // sémantiquement proche du sujet en cours (ex. « Parlons de vos tarifs »
      // juste après une question sur les tarifs = continuation, pas un changement).
      if (simUser === null) return true;
      return simUser < TOPIC_EXPLICIT_HINT_THRESHOLD;
    }

    // Sans signal explicite : une phrase qui commence par un connecteur de
    // suite (« Et… », « Aussi… ») est une continuation, jamais un changement.
    if (CONTINUATION_PREFIX.test(message.trim())) return false;

    if (simUser === null) return lexicalOverlapIsLow(message, lastUserMsg);
    if (simUser >= TOPIC_SIMILARITY_THRESHOLD) return false;

    // Décrochage par rapport à la question précédente : on vérifie aussi la
    // réponse précédente. Calculée UNIQUEMENT ici (économie d'embeddings :
    // ce cas est rare, la plupart des messages sont des continuations).
    if (lastAssistantMsg) {
      const embAssist = await generateEmbedding(lastAssistantMsg);
      if (embAssist) simAssistant = cosineSimilarity(embNew, embAssist);
    }
    if (simAssistant === null) return true;
    return simAssistant < TOPIC_SIMILARITY_THRESHOLD;
  } catch {
    // Embeddings indisponibles → repli lexical (ou confiance au signal explicite)
    if (explicitHint) return true;
    if (CONTINUATION_PREFIX.test(message.trim())) return false;
    return lexicalOverlapIsLow(message, lastUserMsg);
  }
}

// Consigne permanente : répondre à la question la plus récente, même si elle
// change de sujet (contre l'effet « bloqué sur l'ancien thème »).
const FOLLOW_LATEST_QUESTION_NOTE =
  "\n\n« CONSIGNE : réponds UNIQUEMENT à la question la plus récente du visiteur." +
  " Si elle porte sur un sujet différent des échanges précédents, réponds-y directement," +
  " sans revenir sur les anciens sujets. Le contexte fourni correspond toujours à la question la plus récente. »";

// Consigne renforcée injectée quand un changement de sujet est détecté
const TOPIC_SHIFT_SYSTEM_NOTE =
  "\n\n« IMPORTANT — CHANGEMENT DE SUJET : le visiteur vient de changer de sujet." +
  " Réponds UNIQUEMENT à sa dernière question, comme si la conversation recommençait," +
  " en t'appuyant sur le contexte fourni ci-dessus. Aucune référence aux échanges précédents. »";

/**
 * Détermine si le contexte RAG trouvé est suffisant pour répondre.
 * Considéré insuffisant si :
 *   - aucun passage pertinent n'a été trouvé, ou
 *   - le meilleur score vectoriel est très faible (< 0.25).
 */
function isContextSufficient(relevantChunks, usedVectorSearch) {
  if (!relevantChunks || relevantChunks.length === 0) return false;
  if (usedVectorSearch && relevantChunks[0].score < 0.25) return false;
  return true;
}

/**
 * Explore le site web (si activé et autorisé) et renvoie le bloc de contexte.
 * Renvoie "" silencieusement en cas d'échec (jamais bloquant).
 */
async function getSiteContextBlock(settings, siteUrl, message) {
  if (settings.siteExploration === false) return "";
  // L'URL configurée dans l'admin prime sur celle envoyée par le widget
  // (le widget peut tourner en test depuis un autre domaine).
  const target = (settings.siteUrl || siteUrl || "").trim();
  if (!target || !isSafeSiteUrl(target)) return "";
  try {
    const matches = await searchSiteContent(target, message, 4);
    if (!matches || matches.length === 0) return "";
    console.log(`🌐 Exploration du site : ${matches.length} passages trouvés pour la question`);
    return buildSiteContextBlock(matches);
  } catch (err) {
    console.warn("⚠️ Exploration du site échouée:", err.message);
    return "";
  }
}

// Cache RAG : documents + chunks + index mots-clés chargés en mémoire ──
// Évite de relire data/store.json à chaque requête chat, et évite de
// RE-TOKENISER tous les chunks à chaque message (coût CPU sur gros corpus).
let ragCache = { documents: null, chunks: [], index: [], lastReload: 0 };
const RAG_CACHE_TTL = 5000; // 5 secondes entre chaque rechargement

function getRagContext() {
  const now = Date.now();
  if (!ragCache.documents || now - ragCache.lastReload > RAG_CACHE_TTL) {
    ragCache.documents = getDocuments();
    ragCache.lastReload = now;
    // Pré-construit la liste plate chunks + titres + embeddings pour la
    // recherche vectorielle, ET l'index tokenisé pour la recherche mots-clés
    // (buildChunkIndex est peu coûteux en mémoire : une Map de fréquences
    // par chunk, reconstruite seulement toutes les 5 s ou au changement).
    const entries = [];
    for (const doc of ragCache.documents) {
      if (doc.chunks) {
        for (let i = 0; i < doc.chunks.length; i++) {
          entries.push({
            chunk: doc.chunks[i],
            embedding: doc.embeddings?.[i] || null,
            title: doc.title || "Sans titre"
          });
        }
      }
    }
    ragCache.chunks = entries;
    ragCache.index = buildChunkIndex(ragCache.documents);
  }
  return { documents: ragCache.documents, chunkEntries: ragCache.chunks, chunkIndex: ragCache.index };
}

// Cache pour les suggestions : générées avec l'IA toutes les 10 minutes,
// ou immédiatement dès que la base de connaissances change.
let suggestionsCache = [];
let suggestionsCacheTime = 0;
let suggestionsCacheKey = "";
let suggestionsInFlight = null;  // promesse partagée : évite 2 appels LLM concurrents
let suggestionsInFlightKey = "";
const SUGGESTIONS_CACHE_TTL = 10 * 60 * 1000;

// Cache des suggestions DE SUIVI (conversationnelles), par session + message.
const conversationSuggestionsCache = new Map();
const convSuggestionsInFlight = new Map(); // promesses en cours (dédoublonnage)
const CONV_SUGGESTIONS_TTL = 60 * 1000; // 60 s par échange
const CONV_SUGGESTIONS_MAX_ENTRIES = 300;

/** Petit hash stable pour la clé de cache des suggestions conversationnelles. */
function shortHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return String(h >>> 0);
}

app.get("/api/widget-suggestions", widgetCors, async (req, res) => {
  const now = Date.now();
  let documents;
  try {
    documents = getDocuments();
  } catch {
    documents = [];
  }
  // Clé du cache : change dès qu'un document est ajouté/modifié/supprimé
  const docsKey = documents.map((d) => `${d.id}:${(d.content || "").length}`).join("|");

  if (now - suggestionsCacheTime > SUGGESTIONS_CACHE_TTL || suggestionsCacheKey !== docsKey) {
    // Réutilise la génération en cours si elle porte sur les mêmes documents
    if (suggestionsInFlight && suggestionsInFlightKey === docsKey) {
      suggestionsCache = await suggestionsInFlight;
    } else {
      suggestionsInFlightKey = docsKey;
      suggestionsInFlight = (async () => {
        try {
          return await generateContextualSuggestions(documents);
        } catch (err) {
          console.warn("⚠️ Génération des suggestions échouée:", err.message);
          return generateSuggestionsFallback(documents);
        }
      })().finally(() => {
        suggestionsInFlight = null;
        suggestionsInFlightKey = "";
      });
      suggestionsCache = await suggestionsInFlight;
    }
    suggestionsCacheKey = docsKey;
    suggestionsCacheTime = now;
  }

  // Signature de la liste réellement affichée + ETag : le widget la compare pour
  // détecter qu'un document a été ajouté/modifié/supprimé et mettre à jour ses
  // chips, et le navigateur peut revalider en 304 sans re-télécharger le corps.
  const signature = shortHash(JSON.stringify(suggestionsCache));
  const etag = `"${signature}"`;
  res.set("Cache-Control", "public, max-age=60, must-revalidate");
  res.set("ETag", etag);
  if (req.headers["if-none-match"] === etag) {
    return res.status(304).end();
  }
  res.json({ suggestions: suggestionsCache, suggestionsSignature: signature });
});

// ---------------------------------------------------------------------------
// Route publique : suggestions DE SUIVI (conversationnelles)
// Générées selon le dernier échange (historique de session) ET la base de
// connaissances, pour proposer au visiteur des questions qui poursuivent
// naturellement la discussion — pas seulement le catalogue initial.
// ---------------------------------------------------------------------------
app.options("/api/chat/suggestions", widgetCors);
app.post("/api/chat/suggestions", widgetCors, chatSuggestionsLimiter, async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message manquant" });
    }
    const effectiveSessionId = sessionId || "anon-" + crypto.randomUUID();
    const settings = getSettings();
    // Marqueur anti-race : si un reset survient pendant la génération,
    // on n'écrase pas le cache que le reset vient de purger.
    const resetMarkerAtStart = sessionResetMarkers.get(effectiveSessionId) || 0;

    // Option admin : suggestions dynamiques désactivées → liste vide, le widget
    // retombe alors sur les suggestions initiales de la base de connaissances.
    if (settings.conversationalSuggestions === false) {
      return res.json({ suggestions: [] });
    }

    // Historique de la session (déjà sauvegardé par la route chat/stream,
    // y compris la dernière réponse de l'assistante).
    const previous = conversations.get(effectiveSessionId);
    const history = previous ? previous.history.slice(-8) : [];

    // Dédoublonnage : une seule génération par échange (session + message)
    const cacheKey = `${effectiveSessionId}:${shortHash(message)}`;
    const cached = conversationSuggestionsCache.get(cacheKey);
    if (cached && Date.now() - cached.time < CONV_SUGGESTIONS_TTL) {
      return res.json({ suggestions: cached.list });
    }

    // Promesse partagée : deux requêtes simultanées identiques ne déclenchent
    // qu'UN SEUL appel LLM (motif identique au cache des suggestions initiales).
    let inFlight = convSuggestionsInFlight.get(cacheKey);
    if (!inFlight) {
      inFlight = generateConversationalSuggestions(settings, message, history);
      convSuggestionsInFlight.set(cacheKey, inFlight);
      inFlight.finally(() => convSuggestionsInFlight.delete(cacheKey)).catch(() => {});
    }
    const suggestions = await inFlight;

    // Session réinitialisée pendant la génération → on renvoie une liste vide
    // sans réécrire dans le cache purgé.
    if (sessionResetMarkers.get(effectiveSessionId) !== resetMarkerAtStart) {
      return res.json({ suggestions: [] });
    }
    conversationSuggestionsCache.set(cacheKey, { list: suggestions, time: Date.now() });
    if (conversationSuggestionsCache.size > CONV_SUGGESTIONS_MAX_ENTRIES) {
      conversationSuggestionsCache.clear();
    }
    res.json({ suggestions });
  } catch (err) {
    console.error("Erreur suggestions conversationnelles:", err);
    res.json({ suggestions: [] });
  }
});

/**
 * Génère des suggestions de questions CONTEXTUELLES, basées uniquement sur le
 * contenu réel de la base de connaissances, via le modèle d'IA configuré.
 * Plus aucun fallback générique du type « Quels sont vos tarifs ? » : chaque
 * question proposée découle de ce que l'entreprise dit d'elle-même.
 */
async function generateContextualSuggestions(documents) {
  const settings = getSettings();

  // Aucun contenu exploitable → amorces de discussion engageantes (on n'a
  // aucune matière pour faire mieux ; pas de catalogue générique).
  const contents = (documents || [])
    .map((d) => d.content || "")
    .filter((c) => c.trim().length > 20);
  if (contents.length === 0) {
    return [
      "Bonjour, que pouvez-vous faire pour moi ?",
      "Comment commence-t-on ?",
      "Pouvez-vous me guider ?"
    ];
  }

  const providers = getFallbackProviders(settings);
  if (providers.length === 0) return generateSuggestionsFallback(documents);

  const contextPreview = contents.join("\n\n---\n\n").slice(0, 6000);
  const result = await tryProviderChain(providers, apiCall, {
    messages: [
      {
        role: "system",
        content:
          "Tu es un expert en accueil de visiteurs. À partir du contenu de l'entreprise fourni, imagine 5 questions qu'un visiteur pourrait naturellement poser pour engager la conversation et trouver l'information dont il a besoin. " +
          "Contraintes : questions courtes et naturelles (5 à 12 mots), formulées comme un visiteur réel, UNIQUEMENT fondées sur le contenu (produits, prix, contacts, délais, garanties, services…), et variées (pas 5 variantes du même sujet). " +
          "INTERDIT les questions génériques qui conviendraient à n'importe quelle entreprise sans référence au contenu (ex. « Quels sont vos tarifs ? »). " +
          "Renvoie UNIQUEMENT un tableau JSON de chaînes, sans texte avant ni après : [\"question 1\", \"question 2\", \"question 3\", \"question 4\", \"question 5\"]"
      },
      { role: "user", content: "Contenu de l'entreprise :\n\n" + contextPreview }
    ],
    maxTokens: 300
  });

  if (!result.ok) return generateSuggestionsFallback(documents);
  const raw = result.data.choices?.[0]?.message?.content || "";
  const parsed = parseSuggestionList(raw);
  if (parsed.length === 0) return generateSuggestionsFallback(documents);
  return parsed.slice(0, 6);
}

/**
 * Parse la réponse de l'IA : JSON strict d'abord, puis extraction des lignes
 * se terminant par un point d'interrogation.
 */
function parseSuggestionList(raw) {
  if (!raw) return [];
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const arr = JSON.parse(jsonMatch[0]);
      if (Array.isArray(arr)) {
        return arr
          .map((s) => String(s).trim().replace(/^[-•*\d.\s]+/, ""))
          .filter((s) => s.length > 4 && s.length < 120);
      }
    } catch { /* pas du JSON → extraction ligne par ligne */ }
  }
  return raw.split("\n")
    .map((l) => l.trim().replace(/^[-•*\d.\s]+/, ""))
    .filter((l) => l.endsWith("?") && l.length > 4 && l.length < 120);
}

/**
 * Fallback sans IA : suggestions construites uniquement à partir du contenu
 * des documents — questions littérales de la FAQ + phrases-clés factuelles.
 * Jamais de questions génériques pré-écrites.
 */
function generateSuggestionsFallback(documents) {
  const out = [];
  const push = (q) => {
    const t = String(q).trim();
    if (t && t.length > 6 && t.length < 120 && !out.includes(t)) out.push(t);
  };

  for (const doc of documents || []) {
    const content = doc.content || "";

    // 1) Questions littérales présentes dans le contenu (FAQ naturelle)
    for (const line of content.split("\n")) {
      const l = line.trim();
      if (l.endsWith("?") && l.length > 8 && l.length < 110) push(l);
      if (out.length >= 6) break;
    }

    // 2) Phrases-clés factuelles → question engageante qui s'y réfère
    if (out.length < 6) {
      const sentences = content.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
      for (const s of sentences) {
        if (s.length < 15 || s.length > 160) continue;
        if (!/[0-9]|€|@|t[eé]l|horaire|livraison|garantie|tarif|prix|service|produit|offre/i.test(s)) continue;
        const snippet = s.replace(/[.!?]+$/, "").trim().slice(0, 70);
        push(`Pouvez-vous m'en dire plus sur ${snippet.charAt(0).toUpperCase()}${snippet.slice(1)} ?`);
        if (out.length >= 6) break;
      }
    }

    if (out.length >= 6) break;
  }

  return out.length ? out : [
    "Bonjour, que pouvez-vous faire pour moi ?",
    "Comment commence-t-on ?",
    "Pouvez-vous me guider ?"
  ];
}

/**
 * Génère des suggestions DE SUIVI, adaptées au fil de la conversation en cours
 * (pas seulement à la base de connaissances) : l'IA rebondit sur le dernier
 * échange pour proposer des questions qui approfondissent naturellement le sujet.
 */
async function generateConversationalSuggestions(settings, lastMessage, history) {
  const providers = getFallbackProviders(settings);
  if (providers.length === 0) return [];

  // Base de connaissances (pour ancrer les questions dans le concret)
  const documents = getDocuments();
  const contents = (documents || [])
    .map((d) => d.content || "")
    .filter((c) => c.trim().length > 20);
  const kbContext = contents.join("\n\n---\n\n").slice(0, 4000);

  // Fil conversationnel (les derniers échanges, le cas échéant)
  const transcript = history.length
    ? history.map((m) => `${m.role === "user" ? "Visiteur" : "Assistante"}: ${m.content}`).join("\n")
    : `Visiteur: ${lastMessage}`;

  const result = await tryProviderChain(providers, apiCall, {
    messages: [
      {
        role: "system",
        content:
          "Tu es un expert en conversation. À partir de la discussion ci-dessous entre un visiteur et l'assistante d'une entreprise, imagine 4 questions que le visiteur pourrait naturellement poser ENSUITE pour poursuivre et approfondir l'échange. " +
          "Contraintes : chaque question doit être une SUITE logique de la discussion (rebondir sur ce qui vient d'être dit, ne jamais répéter une question déjà posée), courte et naturelle (5 à 12 mots), et ancrée dans le contenu de l'entreprise fourni. " +
          "INTERDIT les questions génériques ou hors sujet (ex. ne proposez pas « Quels sont vos tarifs ? » si la conversation porte sur les délais de livraison). " +
          "Renvoie UNIQUEMENT un tableau JSON de chaînes, sans texte avant ni après : [\"question 1\", \"question 2\", \"question 3\", \"question 4\"]"
      },
      {
        role: "user",
        content: `Contenu de l'entreprise (pour ancrer les questions) :\n${kbContext || "(aucun)"}\n\n---\n\nDiscussion en cours :\n${transcript}`
      }
    ],
    maxTokens: 300
  });

  if (!result.ok) return [];
  const raw = result.data.choices?.[0]?.message?.content || "";
  return parseSuggestionList(raw).slice(0, 4);
}

// ─── Arrêt gracieux (graceful shutdown) ─────────────────────────────────
function shutdown(signal) {
  console.log(`\n${signal} reçu. Arrêt du serveur...`);
  // Stop l'anti-veille : plus aucun self-ping pendant l'arrêt.
  if (keepAwakeTimeout) clearTimeout(keepAwakeTimeout);
  if (keepAwakeInterval) clearInterval(keepAwakeInterval);
  server.close(() => {
    console.log("Serveur arrêté.");
    process.exit(0);
  });
  // Force l'arrêt après 5s si les connexions ne se ferment pas
  setTimeout(() => {
    console.error("Arrêt forcé après timeout.");
    process.exit(1);
  }, 5000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ─── Préchargement lazy du modèle d'embedding ────────────────────────
// Le modèle est chargé en arrière-plan après le démarrage du serveur.
// Si le chargement échoue (pas d'internet, modèle non trouvé), le RAG
// continuera de fonctionner en mode mots-clés.
setTimeout(async () => {
  try {
    console.log("🔄 Préchargement du modèle d'embedding…");
    await ensureEmbeddingModel();
    console.log("✅ Modèle d'embedding disponible");
  } catch (err) {
    console.warn("⚠️ Préchargement du modèle d'embedding échoué:", err.message);
    console.warn("   Le RAG utilisera la recherche par mots-clés jusqu'au rechargement.");
  }
}, 0); // Céde la boucle d'événements au démarrage du serveur

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
  console.log(`Tableau de bord admin : http://localhost:${PORT}/admin`);
});

// ─── Anti-veille intégré (Render, Railway… plans gratuits) ─────────────
// Les plateformes PaaS (Render free tier, Railway…) mettent le service en
// veille après ~15 min SANS TRAFIC ENTRANT. Plutôt qu'un cron externe
// (GitHub Actions) ou un moniteur tiers (UptimeRobot), le serveur se ping
// LUI-MÊME sur son URL publique : le trafic entrant régulier empêche la
// mise en veille, sans aucune dépendance externe. La requête passe par le
// reverse proxy de la plateforme → elle compte comme du trafic réel.
// Activation : PUBLIC_URL explicite (ex. https://chatbot-aida.onrender.com),
// SINON RENDER_EXTERNAL_URL — injecté AUTOMATIQUEMENT par Render sur chaque
// web service (https://mon-app.onrender.com). Ce fallback rend l'anti-veille
// actif dès le déploiement via le Blueprint, sans aucune saisie manuelle.
// Autres plateformes (Railway…) : définir PUBLIC_URL.
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
const KEEP_AWAKE_INTERVAL_MS = Math.max(
  Number(process.env.KEEP_AWAKE_INTERVAL_MS) || 5 * 60 * 1000,
  5 * 1000 // garde-fou : jamais plus fréquent qu'une tentative toutes les 5 s
);
// Handles des timers : nettoyés à l'arrêt gracieux (shutdown) pour ne pas
// laisser un self-ping en vol retarder server.close().
let keepAwakeTimeout = null;
let keepAwakeInterval = null;

if (PUBLIC_URL) {
  const intervalLabel = KEEP_AWAKE_INTERVAL_MS < 60000
    ? `${Math.round(KEEP_AWAKE_INTERVAL_MS / 1000)} s`
    : `${Math.round(KEEP_AWAKE_INTERVAL_MS / 60000)} min`;
  console.log(`⏰ Anti-veille actif : self-ping ${PUBLIC_URL}${KEEPALIVE_PATH} toutes les ${intervalLabel}`);
  let consecutiveFailures = 0;
  const keepAwakePing = async () => {
    try {
      const res = await fetch(`${PUBLIC_URL}${KEEPALIVE_PATH}`, {
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      consecutiveFailures = 0;
    } catch (err) {
      // Un échec (réseau, instance en cours de démarrage…) ne doit JAMAIS
      // faire échouer le serveur : le prochain intervalle réessaiera.
      consecutiveFailures++;
      if (consecutiveFailures === 1 || consecutiveFailures % 10 === 0) {
        console.warn(`⏰ Anti-veille : ping échoué (${consecutiveFailures} consécutif(s)) — ${err.message}`);
      }
    }
  };
  // Premier ping après un court délai (laisse le temps au serveur de démarrer),
  // puis toutes les KEEP_AWAKE_INTERVAL_MS.
  keepAwakeTimeout = setTimeout(keepAwakePing, 30 * 1000);
  keepAwakeInterval = setInterval(keepAwakePing, KEEP_AWAKE_INTERVAL_MS);
} else {
  console.log("ℹ️ Anti-veille désactivé (ni PUBLIC_URL ni RENDER_EXTERNAL_URL définies). Sur les plans gratuits, le service peut se mettre en veille après ~15 min d'inactivité.");
}
