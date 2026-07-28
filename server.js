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
  deleteDocument
} from "./lib/store.js";
import { retrieveRelevantChunks, retrieveRelevantChunksSync, buildContextBlock } from "./lib/retrieval.js";
import { ensureEmbeddingModel, generateEmbedding, findSimilarChunks } from "./lib/embedding.js";

const require = createRequire(import.meta.url);
const { PDFParse } = require("pdf-parse");

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: "10mb" }));

// ─── Headers de sécurité HTTP ──────────────────────────────────────────
// CSP configuré pour permettre l'embedding du widget sur n'importe quel site
// tout en bloquant les injections XSS et le MIME sniffing.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "data:"],
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

// Liste des modèles de fallback en cas de rate limit (429)
const FALLBACK_MODELS = ["openrouter/free"];

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
async function apiCallStream({ baseUrl, apiKey, model, messages, maxTokens, extraHeaders, res, signal }) {
  const headers = {
    "Content-Type": "application/json",
    ...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}),
    ...(extraHeaders || {})
  };

  // Timeout de 30 secondes pour l'appel streaming
  const timeoutSignal = AbortSignal.timeout(30000);
  // Combine le signal passé (abortController) avec le timeout
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      signal: combinedSignal,
      body: JSON.stringify({
        model,
        max_tokens: maxTokens || 800,
        messages,
        stream: true
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return { ok: false, status: response.status, errText };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = "";
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") break;

        try {
          const parsed = JSON.parse(data);
          const token = parsed.choices?.[0]?.delta?.content || "";
          if (token) {
            fullContent += token;
            // Écrit directement dans la réponse SSE
            res.write(`data: ${JSON.stringify({ token })}\n\n`);
          }
        } catch { /* ignorer les lignes mal formées */ }
      }
    }

    // Envoie le signal de fin avec le contenu complet + modèle utilisé
    res.write(`data: ${JSON.stringify({ done: true, fullContent })}\n\n`);
    return { ok: true, fullContent };
  } catch (err) {
    if (err.name === "AbortError") {
      return { ok: false, status: 499, errText: "Requête annulée" };
    }
    console.error(`Erreur réseau streaming (${baseUrl}):`, err.message);
    return { ok: false, status: 503, errText: err.message || "Erreur réseau" };
  }
}

/**
 * Retourne la liste ordonnée des providers à essayer (OpenRouter → fallbacks externes)
 * en fonction des clés configurées dans les settings.
 */
function getFallbackProviders(settings) {
  const providers = [];
  const configuredModel = settings.model || "openrouter/free";

  // OpenRouter : modèle configuré + fallback openrouter/free
  const orModels = [configuredModel];
  for (const fb of FALLBACK_MODELS) {
    if (fb !== configuredModel) orModels.push(fb);
  }
  for (const m of orModels) {
    providers.push({
      name: m,
      model: m,
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: settings.apiKey,
      extraHeaders: OR_HEADERS
    });
  }

  // Fallbacks externes
  if (settings.groqApiKey) {
    providers.push({
      name: "Groq",
      model: "llama-3.3-70b-versatile",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: settings.groqApiKey
    });
  }
  if (settings.siliconflowApiKey) {
    providers.push({
      name: "SiliconFlow",
      model: "deepseek-ai/DeepSeek-V3",
      baseUrl: "https://api.siliconflow.cn/v1",
      apiKey: settings.siliconflowApiKey
    });
  }
  if (settings.customApiUrl) {
    providers.push({
      name: "API locale",
      model: settings.customApiModel || "llama3.1-8b",
      baseUrl: settings.customApiUrl.replace(/\/+$/, ""),
      apiKey: settings.customApiKey || ""
    });
  }
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
        modelUsed: provider.extraHeaders ? result.modelUsed : `${result.modelUsed} (${provider.name} fallback)`,
        fallbackUsed: i > 0,
        originalModel: providers[0].model,
        provider
      };
    }

    lastResult = result;

    // Erreur non-récupérable (401, 403, etc.) → stop immédiat
    if (result.status !== 429 && result.status < 500) {
      console.error(`Erreur ${provider.name}:`, result.errText);
      return { ok: false, status: result.status, errText: result.errText, provider };
    }

    // 429 ou 5xx → continue vers le provider suivant
    console.warn(`${provider.name} ${result.status}, passage au suivant`);
  }

  // Tous les providers ont échoué
  return lastResult || { ok: false, status: 503, errText: "Aucun fournisseur disponible" };
}

/**
 * Appelle l'API avec fallback automatique (version non-streaming).
 * Maintient la compatibilité avec les appels existants.
 */
async function callOpenRouterWithFallback({ apiKey, model, messages, maxTokens, groqApiKey, siliconflowApiKey, customApiUrl, customApiKey, customApiModel, openaiApiKey }) {
  const settings = {
    apiKey, model, maxTokens,
    groqApiKey, siliconflowApiKey,
    customApiUrl, customApiKey, customApiModel,
    openaiApiKey
  };
  const providers = getFallbackProviders(settings);
  return await tryProviderChain(providers, apiCall, { messages, maxTokens });
}

// Historique de conversation en mémoire par session
// (pour la prod : remplacer par Redis ou une base de données)
const conversations = new Map();

// Nettoie les conversations inactives toutes les 30 minutes
const CONVERSATION_TTL = 60 * 60 * 1000; // 1 heure sans activité
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of conversations) {
    if (now - session.lastActivity > CONVERSATION_TTL) {
      conversations.delete(sessionId);
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

// ---------------------------------------------------------------------------
// Middleware d'authentification admin — vérifie le mot de passe configuré.
// Sécurisé pour la production : vérifie que le mot de passe est défini.
// ---------------------------------------------------------------------------
function requireAdmin(req, res, next) {
  const provided = req.headers["x-admin-password"];
  if (!process.env.ADMIN_PASSWORD || !provided || provided !== process.env.ADMIN_PASSWORD) {
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
  if (process.env.ADMIN_PASSWORD && password === process.env.ADMIN_PASSWORD) {
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
    siliconflowApiKey: maskKey(settings.siliconflowApiKey),
    hasSiliconflowApiKey: !!settings.siliconflowApiKey,
    customApiKey: maskKey(settings.customApiKey),
    hasCustomApiKey: !!settings.customApiKey
  });
});

app.post("/api/admin/settings", requireAdmin, (req, res) => {
  const { apiKey, openaiApiKey, groqApiKey, siliconflowApiKey, customApiUrl, customApiKey, customApiModel, model, botName, welcomeMessage, systemPrompt, maxTokens, accentColor, accentColorDark, fontFamily } = req.body;

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
  // customApiUrl et customApiModel : seulement si une valeur est fournie
  // (évite d'écraser avec une chaîne vide quand l'utilisateur sauvegarde d'autres champs)
  if (customApiUrl) patch.customApiUrl = customApiUrl;
  if (customApiModel) patch.customApiModel = customApiModel;

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
  if (siliconflowApiKey && !siliconflowApiKey.includes("•")) patch.siliconflowApiKey = siliconflowApiKey;
  if (customApiKey && !customApiKey.includes("•")) patch.customApiKey = customApiKey;

  const updated = saveSettings(patch);
  res.json({ ok: true, settings: { ...updated, apiKey: undefined, openaiApiKey: undefined, groqApiKey: undefined, siliconflowApiKey: undefined, customApiKey: undefined } });
});

// ---------------------------------------------------------------------------
// Route admin : test de connexion à l'API OpenRouter
// ---------------------------------------------------------------------------
app.post("/api/admin/test-connection", requireAdmin, async (req, res) => {
  try {
    const { apiKey, model } = req.body;

    // Utilise la clé fournie ou celle enregistrée
    const testKey = apiKey || getSettings().apiKey;
    const testModel = model || getSettings().model || "openrouter/free";

    if (!testKey) {
      return res.json({ ok: false, error: "Aucune clé API fournie." });
    }

    // Récupère les clés de fallback (saisie ou enregistrée)
    const settings = getSettings();
    const openAiKey = req.body.openaiApiKey || settings.openaiApiKey;
    const groqKey = req.body.groqApiKey || settings.groqApiKey;
    const siliconflowKey = req.body.siliconflowApiKey || settings.siliconflowApiKey;
    const customUrl = req.body.customApiUrl || settings.customApiUrl;
    const customKey = req.body.customApiKey || settings.customApiKey;
    const customModel = req.body.customApiModel || settings.customApiModel || "llama3.1-8b";

    const result = await callOpenRouterWithFallback({
      apiKey: testKey,
      model: testModel,
      messages: [
        { role: "user", content: "Test de connexion — réponds uniquement \"OK\"." }
      ],
      maxTokens: 10,
      groqApiKey: groqKey,
      siliconflowApiKey: siliconflowKey,
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

    const base64Content = base64Data.includes("base64,")
      ? base64Data.split("base64,")[1]
      : base64Data;

    const buffer = Buffer.from(base64Content, "base64");

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
    const { message, sessionId } = req.body;
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
    if (!settings.apiKey) {
      return res.status(400).json({
        error: "Aucune clé API configurée. Va dans /admin pour en ajouter une."
      });
    }

    // 1. Récupération du contexte pertinent (RAG vectoriel + mots-clés) via cache
    const { documents, chunkEntries } = getRagContext();
    const queryEmbedding = chunkEntries.length > 0 && chunkEntries.some(e => e.embedding)
      ? await generateEmbedding(message).catch(() => null)
      : null;
    let relevantChunks = [];
    if (queryEmbedding) {
      relevantChunks = findSimilarChunks(queryEmbedding, chunkEntries, 4);
    }
    if (relevantChunks.length === 0) {
      relevantChunks = retrieveRelevantChunksSync(documents, message, 4);
    }
    const contextBlock = buildContextBlock(relevantChunks);

    // 2. Historique de conversation (copie pour éviter la corruption en cas d'échec)
    const storedSession = conversations.get(effectiveSessionId) || { history: [], lastActivity: Date.now() };
    storedSession.lastActivity = Date.now();
    const history = [...storedSession.history, { role: "user", content: message }];

    // 3. Appel à l'API OpenRouter (compatible OpenAI)
    const messages = [
      { role: "system", content: (settings.systemPrompt || "") + contextBlock },
      ...history
    ];

    const result = await callOpenRouterWithFallback({
      apiKey: settings.apiKey,
      model: settings.model || "openrouter/free",
      messages,
      maxTokens: settings.maxTokens || 800,
      groqApiKey: settings.groqApiKey,
      siliconflowApiKey: settings.siliconflowApiKey,
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
      } else if (result.status === 401 || result.status === 403) {
        userMessage = `Erreur IA : la clé API OpenRouter est invalide ou a expiré. Vérifie-la dans /admin.`;
      } else {
        userMessage = `Erreur IA : ${detail}${result.status >= 500 ? ' (le fournisseur est peut-être temporairement indisponible)' : ''}`;
      }
      return res.status(502).json({ error: userMessage });
    }

    const reply = result.data.choices?.[0]?.message?.content || "Désolé, je n'ai pas compris.";

    // Sauvegarde de la conversation uniquement en cas de succès de l'appel
    const updatedHistory = [...history, { role: "assistant", content: reply }];
    conversations.set(effectiveSessionId, { history: updatedHistory.slice(-20), lastActivity: Date.now() });

    res.json({
      reply,
      sourcesUsed: relevantChunks.map((r) => r.title),
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

  try {
    const { message, sessionId } = req.body;
    if (!message || typeof message !== "string") {
      res.write(`data: ${JSON.stringify({ error: "Message manquant" })}\n\n`);
      return res.end();
    }
    if (message.length > 4000) {
      res.write(`data: ${JSON.stringify({ error: "Message trop long (maximum 4000 caractères)." })}\n\n`);
      return res.end();
    }

    const effectiveSessionId = sessionId || "anon-" + crypto.randomUUID();
    const settings = getSettings();

    if (!settings.apiKey) {
      res.write(`data: ${JSON.stringify({ error: "Aucune clé API configurée" })}\n\n`);
      return res.end();
    }

    // 1. Contexte RAG (avec cache intégré)
    const { chunkEntries } = getRagContext();
    const queryEmbedding = chunkEntries.length > 0 && chunkEntries.some(e => e.embedding)
      ? await generateEmbedding(message).catch(() => null)
      : null;
    
    let relevantChunks = [];
    if (queryEmbedding) {
      relevantChunks = findSimilarChunks(queryEmbedding, chunkEntries, 4);
    }
    if (relevantChunks.length === 0) {
      const docs = ragCache.documents || getDocuments();
      relevantChunks = retrieveRelevantChunksSync(docs, message, 4);
    }
    const contextBlock = buildContextBlock(relevantChunks);

    // 2. Historique
    const storedSession = conversations.get(effectiveSessionId) || { history: [], lastActivity: Date.now() };
    storedSession.lastActivity = Date.now();
    const history = [...storedSession.history, { role: "user", content: message }];

    // 3. Messages pour l'API
    const messages = [
      { role: "system", content: (settings.systemPrompt || "") + contextBlock },
      ...history
    ];

    // 4. Chaîne de fallback via la fonction partagée
    const abortController = new AbortController();
    const providers = getFallbackProviders(settings);

    const streamResult = await tryProviderChain(providers, (opts) => apiCallStream({ ...opts, res, signal: abortController.signal }), {
      messages,
      maxTokens: settings.maxTokens || 800
    });

    if (!streamResult.ok) {
      const errStatus = streamResult.status;
      let errMsg;
      if (errStatus === 401 || errStatus === 403) {
        errMsg = "La clé API est invalide ou a expiré. Vérifie-la dans /admin.";
      } else if (errStatus === 429) {
        errMsg = "Tous les fournisseurs sont saturés (429). Réessaie dans quelques instants.";
      } else if (errStatus >= 500) {
        errMsg = "Les fournisseurs IA sont temporairement indisponibles. Réessaie plus tard.";
      } else {
        errMsg = "Erreur de connexion aux fournisseurs IA. Vérifie ta configuration dans /admin.";
      }
      res.write(`data: ${JSON.stringify({ error: errMsg })}\n\n`);
      return res.end();
    }

    // Sauvegarde de la conversation
    const fullReply = streamResult.fullContent || "";
    const updatedHistory = [...history, { role: "assistant", content: fullReply }];
    conversations.set(effectiveSessionId, { history: updatedHistory.slice(-20), lastActivity: Date.now() });

    // Signal de fin avec métadonnées
    res.write(`data: ${JSON.stringify({ done: true, fullContent, modelUsed: streamResult.modelUsed, fallbackUsed: streamResult.fallbackUsed, sourcesUsed: relevantChunks.map(r => r.title) })}\n\n`);
    res.end();
  } catch (err) {
    console.error("Erreur streaming:", err);
    try {
      res.write(`data: ${JSON.stringify({ error: "Erreur serveur" })}\n\n`);
      res.end();
    } catch { /* already closed */ }
  }
});

// Health check pour monitoring / load balancer
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    version: "1.0.0",
    embedding: !!require("./lib/embedding.js") // vérifie que le module est accessible
  });
});

// Le widget lit ces infos publiques (nom du bot, message d'accueil) au chargement
app.get("/api/widget-config", widgetCors, (req, res) => {
  const settings = getSettings();
  res.json({
    botName: settings.botName,
    welcomeMessage: settings.welcomeMessage,
    accentColor: settings.accentColor || "#2f6fed",
    accentColorDark: settings.accentColorDark || "#1f4fb8",
    fontFamily: settings.fontFamily || "system-ui"
  });
});

// ─── Cache RAG : documents + chunks chargés en mémoire ────────────────
// Évite de relire data/store.json à chaque requête chat
let ragCache = { documents: null, chunks: [], lastReload: 0 };
const RAG_CACHE_TTL = 5000; // 5 secondes entre chaque rechargement

function getRagContext() {
  const now = Date.now();
  if (!ragCache.documents || now - ragCache.lastReload > RAG_CACHE_TTL) {
    ragCache.documents = getDocuments();
    ragCache.lastReload = now;
    // Pré-construit la liste plate chunks + titres pour la recherche
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
  }
  return { documents: ragCache.documents, chunkEntries: ragCache.chunks };
}

// Cache pour les suggestions (regénéré toutes les 30s)
let suggestionsCache = [];
let suggestionsCacheTime = 0;
const SUGGESTIONS_CACHE_TTL = 30 * 1000;

app.get("/api/widget-suggestions", widgetCors, (req, res) => {
  const now = Date.now();
  if (now - suggestionsCacheTime > SUGGESTIONS_CACHE_TTL) {
    const documents = getDocuments();
    suggestionsCache = generateSuggestions(documents);
    suggestionsCacheTime = now;
  }
  res.json({ suggestions: suggestionsCache });
});

function generateSuggestions(documents) {
  const defaults = [
    "Quels sont vos services ?",
    "Comment puis-je vous contacter ?",
    "Quels sont vos tarifs ?",
    "Pouvez-vous m'aider ?"
  ];

  if (!documents || documents.length === 0) return defaults;

  const docSuggestions = [];
  const pushIfNew = (item) => { if (!docSuggestions.includes(item)) docSuggestions.push(item); };

  for (const doc of documents) {
    const title = (doc.title || "").trim();
    const content = doc.content || "";
    const titleLower = title.toLowerCase();

    // Extrait les questions du contenu (naturelles, jamais un nom de fichier)
    const questionLines = content.split("\n")
      .map(l => l.trim())
      .filter(l => l.endsWith("?") && l.length > 10 && l.length < 100);
    for (const q of questionLines) {
      pushIfNew(q);
      if (docSuggestions.length >= 8) break;
    }

    // Suggestions contextuelles sans jamais exposer le nom du fichier
    if (/faq|question/.test(titleLower) && !/questions?\s+fréquentes/i.test(content)) {
      pushIfNew("Questions fréquentes sur nos services");
    } else if (/contact/.test(titleLower)) {
      pushIfNew("Comment vous contacter ?");
    } else if (/prix|tarif|forfait/.test(titleLower)) {
      pushIfNew("Quels sont vos tarifs ?");
    } else if (/service|offre/.test(titleLower)) {
      pushIfNew("Quels sont vos services ?");
    } else if (/livraison|expédition|shipping/.test(titleLower)) {
      pushIfNew("Quels sont les délais de livraison ?");
    } else if (/retour|remboursement/.test(titleLower)) {
      pushIfNew("Comment faire un retour ?");
    } else if (/garantie/.test(titleLower)) {
      pushIfNew("Quelle est votre garantie ?");
    } else if (/à propos|about|presentation|présentation/.test(titleLower)) {
      pushIfNew("Pouvez-vous me présenter votre activité ?");
    } else if (/produit|product|catalogue/.test(titleLower)) {
      pushIfNew("Quels produits proposez-vous ?");
    } else {
      // Aucun mot-clé détecté → suggestion subtile depuis le contenu
      if (content.length > 80) {
        pushIfNew("Que contient ce document ?");
        if (docSuggestions.length < 4) pushIfNew("Quels sont les points importants ?");
      }
    }

    if (docSuggestions.length >= 6) break;
  }

  // Fusion avec les suggestions par défaut
  const all = [...new Set([...docSuggestions, ...defaults])];
  return all.slice(0, 6);
}

// ─── Arrêt gracieux (graceful shutdown) ─────────────────────────────────
function shutdown(signal) {
  console.log(`\n${signal} reçu. Arrêt du serveur...`);
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
