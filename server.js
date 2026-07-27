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
  // On masque la clé API dans la réponse (on ne renvoie que les 6 derniers caractères)
  const masked = settings.apiKey
    ? "•".repeat(Math.max(settings.apiKey.length - 6, 0)) + settings.apiKey.slice(-6)
    : "";
  res.json({ ...settings, apiKey: masked, hasApiKey: !!settings.apiKey });
});

app.post("/api/admin/settings", requireAdmin, (req, res) => {
  const { apiKey, model, botName, welcomeMessage, systemPrompt, maxTokens, accentColor, accentColorDark, fontFamily } = req.body;
  const patch = { model, botName, welcomeMessage, systemPrompt, maxTokens, accentColor, accentColorDark, fontFamily };
  // On ne remplace la clé API que si une nouvelle valeur non masquée est envoyée
  if (apiKey && !apiKey.includes("•")) {
    patch.apiKey = apiKey;
  }
  const updated = saveSettings(patch);
  res.json({ ok: true, settings: { ...updated, apiKey: undefined } });
});

// ---------------------------------------------------------------------------
// Route admin : test de connexion à l'API OpenRouter
// ---------------------------------------------------------------------------
app.post("/api/admin/test-connection", requireAdmin, async (req, res) => {
  try {
    const { apiKey, model } = req.body;

    // Utilise la clé fournie ou celle enregistrée
    const testKey = apiKey || getSettings().apiKey;
    const testModel = model || getSettings().model || "google/gemma-4-31b-it:free";

    if (!testKey) {
      return res.json({ ok: false, error: "Aucune clé API fournie." });
    }

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${testKey}`,
        "Content-Type": "application/json",
        ...OR_HEADERS
      },
      body: JSON.stringify({
        model: testModel,
        max_tokens: 10,
        messages: [
          { role: "user", content: "Test de connexion — réponds uniquement \"OK\"." }
        ]
      })
    });

    if (response.ok) {
      const data = await response.json();
      const reply = data.choices?.[0]?.message?.content || "";
      const modelUsed = data.model || testModel;
      res.json({
        ok: true,
        message: `Connexion réussie avec ${modelUsed}`,
        model: modelUsed,
        reply: reply.trim()
      });
    } else {
      const errText = await response.text();
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
        status: response.status
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

app.post("/api/admin/documents", requireAdmin, (req, res) => {
  const { title, content } = req.body;
  if (!content || !content.trim()) {
    return res.status(400).json({ error: "Le contenu du document est requis" });
  }
  const doc = addDocument({ title, content });
  res.json({ ok: true, document: { id: doc.id, title: doc.title, addedAt: doc.addedAt } });
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

    const doc = addDocument({ title: filename, content: text });

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

    // 1. Récupération du contexte pertinent (RAG)
    const documents = getDocuments();
    const relevantChunks = retrieveRelevantChunks(documents, message, 4);
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

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json",
        ...OR_HEADERS
      },
      body: JSON.stringify({
        model: settings.model || "google/gemma-4-31b-it:free",
        max_tokens: settings.maxTokens || 800,
        messages
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Erreur API OpenRouter:", errText);
      let detail = "Erreur du service IA.";
      try {
        const errJson = JSON.parse(errText);
        detail = errJson.error?.message || errJson.error || detail;
      } catch {}
      return res.status(502).json({ error: `Erreur IA : ${detail}. Vérifie la clé API dans /admin.` });
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || "Désolé, je n'ai pas compris.";

    // Sauvegarde de la conversation uniquement en cas de succès de l'appel
    const updatedHistory = [...history, { role: "assistant", content: reply }];
    conversations.set(sessionId, { history: updatedHistory.slice(-20), lastActivity: Date.now() });

    res.json({ reply, sourcesUsed: relevantChunks.map((r) => r.title) });
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

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
  console.log(`Tableau de bord admin : http://localhost:${PORT}/admin`);
});
