import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { generateEmbeddings } from "./embedding.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, "..", "data", "store.json");

// Cache mémoire : évite de relire le fichier à chaque appel
let storeCache = null;
let cacheTimestamp = 0;
const CACHE_TTL = 2000; // 2 secondes entre chaque relecture disque

const DEFAULT_STORE = {
  settings: {
    apiKey: "",
    openaiApiKey: "",
    groqApiKey: "",
    siliconflowApiKey: "",
    customApiUrl: "",
    customApiKey: "",
    customApiModel: "llama3.1-8b",
    model: "openrouter/free",
    botName: "Aïda",
    welcomeMessage: "Bonjour ! Je suis Aïda, votre assistante virtuelle. Comment puis-je vous aider aujourd'hui ?",
    systemPrompt:
      "Tu es Aïda, une assistante virtuelle experte, proactive et chaleureuse." +
      "Ton rôle est d'ACCOMPAGNER chaque visiteur vers une solution concrète." +
      "" +
      "RÈGLES FONDAMENTALES :" +
      "1. RÉPONDS avec précision en t'appuyant sur le CONTEXTE fourni ci-dessous (documents, FAQ, fiches produits)." +
      "2. ORIENTE le visiteur vers les ressources pertinentes : articles, fiches conseils, services spécifiques, experts disponibles." +
      "3. PROPOSE activement des solutions : si un visiteur décrit un besoin, suggère-lui les options adaptées (prestations, produits, contenus)." +
      "4. GUIDE la conversation : reformule les questions floues, creuse les besoins implicites, propose un plan d'action clair." +
      "5. RESTE professionnelle et empathique : utilise le vouvoiement, garde un ton chaleureux mais précis." +
      "" +
      "STRUCTURE DE RÉPONSE RECOMMANDÉE :" +
      "- Accusé de réception + reformulation du besoin" +
      "- Réponse principale (basée sur le contexte)" +
      "- Proposition d'orientation (article, service, expert, action recommandée)" +
      "- Question ouverte pour approfondir ou clarifier" +
      "" +
      "Si aucune information pertinente n'est disponible dans le contexte, oriente poliment vers les canaux de contact humain (téléphone, email, formulaire)." +
      "Ne t'excuse pas excessivement : sois utile et pragmatique.",
    maxTokens: 800,
    accentColor: "#2f6fed",
    accentColorDark: "#1f4fb8",
    fontFamily: "system-ui"
  },
  documents: []
};

function ensureStore() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    writeStore(DEFAULT_STORE);
  }
}

function readStore() {
  ensureStore();
  const now = Date.now();
  // Utilise le cache si encore valide
  if (storeCache && now - cacheTimestamp < CACHE_TTL) {
    return storeCache;
  }
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    // Fusionner pour assurer la présence des clés esthétiques (rétrocompatibilité)
    data.settings = { ...DEFAULT_STORE.settings, ...data.settings };
    data.documents = data.documents || [];
    storeCache = data;
    cacheTimestamp = now;
    return data;
  } catch {
    // Fichier corrompu ou manquant → réinitialiser avec les valeurs par défaut
    console.warn("store.json corrompu, réinitialisation avec les valeurs par défaut");
    writeStore(DEFAULT_STORE);
    storeCache = DEFAULT_STORE;
    cacheTimestamp = now;
    return DEFAULT_STORE;
  }
}

function writeStore(store) {
  const tempFile = DATA_FILE + ".tmp";
  fs.writeFileSync(tempFile, JSON.stringify(store, null, 2));
  fs.renameSync(tempFile, DATA_FILE);
  // Invalide le cache après écriture
  storeCache = null;
}

// ---- Paramètres ----

export function getSettings() {
  return readStore().settings;
}

export function saveSettings(patch) {
  const store = readStore();
  store.settings = { ...store.settings, ...patch };
  writeStore(store);
  return store.settings;
}

// ---- Documents (base de connaissances pour le RAG) ----

function chunkText(text, chunkSize = 600) {
  if (!text || !text.trim()) return [];

  // D'abord, tente une découpe par paragraphes (double saut de ligne)
  const paragraphs = text.split(/\n\s*\n/);
  const chunks = [];
  let current = "";

  for (const rawP of paragraphs) {
    const p = rawP.trim();
    if (!p) continue;

    // Si un paragraphe est plus long que chunkSize, on le découpe par phrases
    if (p.length > chunkSize) {
      // Vide le buffer courant d'abord
      if (current) {
        chunks.push(current.trim());
        current = "";
      }
      // Découpe par phrases (point, point d'interrogation, point d'exclamation)
      const sentences = p.split(/(?<=[.!?])\s+/);
      let sentenceBuffer = "";
      for (const s of sentences) {
        const trimmed = s.trim();
        if (!trimmed) continue;
        if ((sentenceBuffer + " " + trimmed).length > chunkSize && sentenceBuffer) {
          chunks.push(sentenceBuffer.trim());
          sentenceBuffer = trimmed;
        } else {
          sentenceBuffer = sentenceBuffer ? sentenceBuffer + " " + trimmed : trimmed;
        }
      }
      if (sentenceBuffer.trim()) chunks.push(sentenceBuffer.trim());
      continue;
    }

    // Paragraphe normal
    if ((current + "\n" + p).length > chunkSize && current) {
      chunks.push(current.trim());
      current = p;
    } else {
      current = current ? current + "\n" + p : p;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text.trim()];
}

export function getDocuments() {
  return readStore().documents;
}

export async function addDocument({ title, content }) {
  const chunks = chunkText(content);

  // Génère les embeddings vectoriels pour chaque chunk (asynchrone)
  let embeddings = null;
  try {
    embeddings = await generateEmbeddings(chunks);
  } catch (err) {
    console.warn("⚠️ Échec de la génération d'embeddings:", err.message);
    // Échec non bloquant : le RAG basculera sur la recherche par mots-clés
  }

  const doc = {
    id: crypto.randomUUID(),
    title: title?.trim() || "Sans titre",
    content: content.trim(),
    chunks,
    embeddings, // null ou tableau de vecteurs aligné sur chunks[]
    addedAt: new Date().toISOString()
  };

  // Relecture du store après l'appel async (generateEmbeddings) pour éviter
  // les race conditions : si un autre addDocument a modifié le store pendant
  // l'attente, on récupère ses changements avant d'écrire.
  const store = readStore();
  store.documents.push(doc);
  writeStore(store);
  return doc;
}

export function deleteDocument(id) {
  const store = readStore();
  store.documents = store.documents.filter((d) => d.id !== id);
  writeStore(store);
}
