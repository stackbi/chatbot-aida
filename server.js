import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { rateLimit } from "express-rate-limit";
import { createRequire } from "module";
import {
  getSettings,
  saveSettings,
  getDocuments,
  addDocument,
  deleteDocument
} from "./lib/store.js";
import { retrieveRelevantChunks, buildContextBlock } from "./lib/retrieval.js";
import { ensureEmbeddingModel } from "./lib/embedding.js";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/admin", express.static(path.join(__dirname, "admin")));

// Le widget est chargé depuis le domaine du client (son propre site), donc les routes
// qu'il appelle doivent accepter les requêtes cross-origin. Le tableau de bord admin,
// lui, est toujours servi et utilisé depuis ce même backend, donc pas besoin de CORS
// sur les routes /api/admin/*.
const widgetCors = cors({ origin: true, methods: ["GET", "POST"] });

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
 * Appelle l'API OpenRouter avec fallback automatique et exponential backoff.
 * Chaîne de fallback (priorité décroissante) :
 *   1. Modèle configuré (via OpenRouter, défaut: openrouter/free)
 *   2. openrouter/free (fallback auto OpenRouter)
 *   3. Groq (free tier très généreux, si clé dispo)
 *   4. SiliconFlow (DeepSeek/Qwen gratuits, si clé dispo)
 *   5. API personnalisée (Ollama/vLLM en local, si URL configurée)
 *   6. OpenAI gpt-4o-mini (payant, si clé dispo — fallback ultime)
 */
async function callOpenRouterWithFallback({ apiKey, model, messages, maxTokens, groqApiKey, siliconflowApiKey, customApiUrl, customApiKey, customApiModel, openaiApiKey }) {
  // ── Phase 1 : essayer les modèles OpenRouter ──
  const modelsToTry = [model];
  for (const fb of FALLBACK_MODELS) {
    if (fb !== model) modelsToTry.push(fb);
  }

  for (let i = 0; i < modelsToTry.length; i++) {
    const currentModel = modelsToTry[i];

    // Exponential backoff avant chaque fallback (sauf le premier essai)
    if (i > 0) {
      const delayMs = Math.min(500 * Math.pow(2, i - 1), 8000);
      console.warn(`⏳ Attente ${delayMs}ms avant fallback vers ${currentModel}...`);
      await new Promise(r => setTimeout(r, delayMs));
    }

    const result = await apiCall({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey,
      model: currentModel,
      messages,
      maxTokens,
      extraHeaders: OR_HEADERS
    });

    if (result.ok) {
      return {
        ok: true,
        data: result.data,
        modelUsed: result.modelUsed,
        fallbackUsed: i > 0,
        originalModel: model
      };
    }

    // Rate limit — on essaye le modèle OpenRouter suivant si disponible
    if (result.status === 429 && i < modelsToTry.length - 1) {
      console.warn(`Rate limit OpenRouter sur ${currentModel}, fallback vers ${modelsToTry[i + 1]}`);
      continue;
    }

    // 429 et plus de fallback OpenRouter → on passe aux fallbacks externes
    if (result.status === 429 && i >= modelsToTry.length - 1) {
      console.warn(`Rate limit OpenRouter sur tous les modèles, passage aux fallbacks externes`);
      break;
    }

    // Autre erreur → on remonte l'erreur
    return { ok: false, status: result.status, errText: result.errText };
  }

  // Compteur de tentatives pour le backoff exponentiel
  let attemptCount = modelsToTry.length;

  // ── Phase 2 : fallback Groq (gratuit, ultra-rapide) ──
  if (groqApiKey) {
    attemptCount++;
    const delayMs = Math.min(500 * Math.pow(2, attemptCount - 1), 8000);
    console.warn(`⏳ Attente ${delayMs}ms avant fallback Groq...`);
    await new Promise(r => setTimeout(r, delayMs));

    const result = await apiCall({
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: groqApiKey,
      model: "llama-3.3-70b-versatile",
      messages,
      maxTokens
    });

    if (result.ok) {
      return {
        ok: true,
        data: result.data,
        modelUsed: `${result.modelUsed} (Groq fallback)`,
        fallbackUsed: true,
        originalModel: model
      };
    }

    if (result.status !== 429) {
      console.error("Erreur Groq:", result.errText);
      return { ok: false, status: result.status, errText: result.errText };
    }
    // 429 → continue vers le fallback suivant
    console.warn("Rate limit Groq, passage au fallback suivant");
  }

  // ── Phase 3 : fallback SiliconFlow (DeepSeek/Qwen gratuits) ──
  if (siliconflowApiKey) {
    attemptCount++;
    const delayMs = Math.min(500 * Math.pow(2, attemptCount - 1), 8000);
    console.warn(`⏳ Attente ${delayMs}ms avant fallback SiliconFlow...`);
    await new Promise(r => setTimeout(r, delayMs));

    const result = await apiCall({
      baseUrl: "https://api.siliconflow.cn/v1",
      apiKey: siliconflowApiKey,
      model: "deepseek-ai/DeepSeek-V3",
      messages,
      maxTokens
    });

    if (result.ok) {
      return {
        ok: true,
        data: result.data,
        modelUsed: `${result.modelUsed} (SiliconFlow fallback)`,
        fallbackUsed: true,
        originalModel: model
      };
    }

    if (result.status !== 429) {
      console.error("Erreur SiliconFlow:", result.errText);
      return { ok: false, status: result.status, errText: result.errText };
    }
    // 429 → continue vers le fallback suivant
    console.warn("Rate limit SiliconFlow, passage au fallback suivant");
  }

  // ── Phase 4 : fallback API personnalisée ──
  if (customApiUrl) {
    attemptCount++;
    const delayMs = Math.min(500 * Math.pow(2, attemptCount - 1), 8000);
    console.warn(`⏳ Attente ${delayMs}ms avant fallback vers API personnalisée...`);
    await new Promise(r => setTimeout(r, delayMs));

    const result = await apiCall({
      baseUrl: customApiUrl.replace(/\/+$/, ""),
      apiKey: customApiKey || "",
      model: customApiModel || "llama3.1-8b",
      messages,
      maxTokens
    });

    if (result.ok) {
      return {
        ok: true,
        data: result.data,
        modelUsed: `${result.modelUsed} (API personnalisée fallback)`,
        fallbackUsed: true,
        originalModel: model
      };
    }

    if (result.status !== 429) {
      console.error("Erreur API personnalisée:", result.errText);
      return { ok: false, status: result.status, errText: result.errText };
    }
    // 429 → continue vers OpenAI
    console.warn("Rate limit API personnalisée, passage au fallback suivant");
  }

  // ── Phase 5 : fallback OpenAI (payant, ultime recours) ──
  if (openaiApiKey) {
    attemptCount++;
    const delayMs = Math.min(500 * Math.pow(2, attemptCount - 1), 8000);
    console.warn(`⏳ Attente ${delayMs}ms avant fallback OpenAI...`);
    await new Promise(r => setTimeout(r, delayMs));

    const result = await apiCall({
      baseUrl: "https://api.openai.com/v1",
      apiKey: openaiApiKey,
      model: "gpt-4o-mini",
      messages,
      maxTokens
    });

    if (result.ok) {
      return {
        ok: true,
        data: result.data,
        modelUsed: "gpt-4o-mini (OpenAI fallback)",
        fallbackUsed: true,
        originalModel: model
      };
    }

    console.error("Erreur API OpenAI:", result.errText);
    return { ok: false, status: result.status, errText: result.errText };
  }

  // Aucun fallback disponible
  return { ok: false, status: 429, errText: "Tous les modèles sont saturés ou aucun fallback configuré" };
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

app.post("/api/admin/login", (req, res) => {
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
  const patch = { model, botName, welcomeMessage, systemPrompt, maxTokens, accentColor, accentColorDark, fontFamily, customApiUrl, customApiModel };

  // On ne remplace chaque clé que si une nouvelle valeur non masquée est envoyée
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

    const pdfData = await pdfParse(buffer);
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

    const settings = getSettings();
    if (!settings.apiKey) {
      return res.status(400).json({
        error: "Aucune clé API configurée. Va dans /admin pour en ajouter une."
      });
    }

    // 1. Récupération du contexte pertinent (RAG vectoriel + mots-clés)
    const documents = getDocuments();
    const relevantChunks = await retrieveRelevantChunks(documents, message, 4);
    const contextBlock = buildContextBlock(relevantChunks);

    // 2. Historique de conversation (copie pour éviter la corruption en cas d'échec)
    const storedSession = conversations.get(sessionId) || { history: [], lastActivity: Date.now() };
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
    conversations.set(sessionId, { history: updatedHistory.slice(-20), lastActivity: Date.now() });

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
  // Suggestions par défaut
  const defaults = [
    "Quels sont vos services ?",
    "Comment puis-je vous contacter ?",
    "Quels sont vos tarifs ?",
    "Pouvez-vous m'aider ?"
  ];

  if (!documents || documents.length === 0) return defaults;

  // Génère des suggestions à partir des titres et contenus des documents
  const docSuggestions = [];
  for (const doc of documents) {
    const title = doc.title || "";
    const content = doc.content || "";

    // Suggestions basées sur le titre
    if (title.toLowerCase().includes("faq") || title.toLowerCase().includes("question")) {
      docSuggestions.push(`Questions fréquentes sur ${title.replace(/^(FAQ|Questions?)\s*/i, "").trim() || "nos services"}`);
    } else if (title.toLowerCase().includes("contact")) {
      docSuggestions.push("Comment vous contacter ?");
    } else if (title.toLowerCase().includes("prix") || title.toLowerCase().includes("tarif") || title.toLowerCase().includes("forfait")) {
      docSuggestions.push("Quels sont vos tarifs ?");
    } else if (title.toLowerCase().includes("service") || title.toLowerCase().includes("offre")) {
      docSuggestions.push(`Quels sont vos services ?`);
    } else if (title.toLowerCase().includes("livraison") || title.toLowerCase().includes("expédition") || title.toLowerCase().includes("shipping")) {
      docSuggestions.push("Quels sont les délais de livraison ?");
    } else if (title.toLowerCase().includes("retour") || title.toLowerCase().includes("remboursement")) {
      docSuggestions.push("Comment faire un retour ?");
    } else if (title.toLowerCase().includes("garantie")) {
      docSuggestions.push("Quelle est votre garantie ?");
    } else {
      docSuggestions.push(`Parlez-moi de ${title}`);
    }

    // Extrais des questions potentielles du contenu
    const questionLines = content.split("\n").filter(line => line.trim().endsWith("?"));
    for (const q of questionLines) {
      const clean = q.trim();
      if (clean.length > 10 && clean.length < 100 && !docSuggestions.includes(clean)) {
        docSuggestions.push(clean);
      }
      if (docSuggestions.length >= 8) break;
    }

    if (docSuggestions.length >= 6) break;
  }

  // Mélange avec les suggestions par défaut, dédoublonne et limite à 6
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
