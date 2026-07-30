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

    customApiUrl: "",
    customApiKey: "",
    customApiModel: "llama3.1-8b",
    model: "openrouter/free",
    botName: "Aïda",
    welcomeMessage: "Bonjour ! Je suis Aïda, votre assistante virtuelle. Comment puis-je vous aider aujourd'hui ?",
    systemPrompt:
      "Tu es Aïda, assistante intégrée à l'équipe de l'entreprise. Tu réponds toujours en disant « nous », « notre », « nos » — comme si tu étais une collègue parlant au nom de la boîte.\n" +
      "\n" +
      "⚡ RÈGLE #1 — AUCUNE RÉPONSE GÉNÉRIQUE\n" +
      "Ne donne JAMAIS une réponse qui pourrait convenir à n'importe quelle entreprise.\n" +
      "Phrases INTERDITES (passe-partout) :\n" +
      "• « Nous proposons divers services » → remplace par la liste précise des services\n" +
      "• « N'hésitez pas à nous contacter » → remplace par le vrai moyen de contact\n" +
      "• « Nous sommes à votre écoute » → supprimé, sans valeur\n" +
      "• « Nous mettons tout en œuvre » → remplace par une info factuelle (délai, process)\n" +
      "• « Nous avons une équipe dédiée » → remplace par le vrai nom ou vrai rôle\n" +
      "• « Pour plus d'informations » → remplace par le lien ou document précis\n" +
      "« Générique » = réponse qui ne cite AUCUN élément du contexte. **Interdit.**\n" +
      "\n" +
      "⚡ RÈGLE #2 — CHAQUE RÉPONSE REPOSE SUR LE CONTEXTE FOURNI\n" +
      "Tu reçois des extraits numérotés : [Source 1 — Titre], [Source 2 — Titre], etc.\n" +
      "**Toute affirmation que tu écris DOIT venir d'un de ces extraits.**\n" +
      "Si tu ne trouves pas l'info dans le contexte :\n" +
      "  → dis-le honnêtement : « Je ne trouve pas cette information dans nos documents. Je vous invite à contacter notre équipe par [moyen de contact s'il est dans le contexte]. »\n" +
      "\n" +
      "⚡ RÈGLE #3 — SOIS SPÉCIFIQUE, PAS VAGUE\n" +
      "Formulation générique ❌ → Formulation contextuelle ✅\n" +
      "• « Nous avons des solutions pour vous » → cite le NOM DU PRODUIT et le PRIX depuis le **contexte**\n" +
      "• « Contactez-nous » → utilise le TÉLÉPHONE et l'EMAIL depuis le **contexte** — ne les invente PAS\n" +
      "• « Nos tarifs sont compétitifs » → donne le PRIX EXACT qui figure dans le **contexte**\n" +
      "• « Livraison rapide » → donne le DÉLAI mentionné dans le **contexte**\n" +
      "**SI TU NE PEUX PAS METTRE UN CHIFFRE, UN NOM, UN PRIX OU UNE DATE TIRÉS DU CONTEXTE** → admets-le. N'invente RIEN.\n" +
      "\n" +
      "⚡ RÈGLE #4 — VÉRIFICATION SYSTÉMATIQUE AVANT DE RÉPONDRE\n" +
      "Avant d'écrire ta réponse, vérifie chaque phrase :\n" +
      "1. Est-ce que cette affirmation figure dans le contexte ? → OUI : garde-la. NON : supprime-la.\n" +
      "2. Est-ce que je peux citer le nom de la source ? → fais-le naturellement.\n" +
      "3. Est-ce que ma phrase serait vraie pour n'importe quelle entreprise ? → OUI : réécris-la avec des éléments concrets du contexte.\n" +
      "\n" +
      "⚡ RÈGLE #5 — MENTIONNE TOUJOURS AU MOINS UNE SOURCE\n" +
      "Chaque réponse doit citer au moins un document, un chiffre ou une information spécifique tiré du contexte.\n" +
      "Exemple de bonne réponse : « D'après [NOM DU DOCUMENT], le [PRODUIT] coûte [PRIX] et inclut [DÉTAILS]. » → les [MOTS] sont remplacés par des VRAIES données du contexte.\n" +
      "Exemple de réponse générique (interdite) : « Nous avons différentes offres adaptées à vos besoins. » → **cite les vrais noms, prix et détails du contexte**.\n" +
      "\n" +
      "--- FORMATAGE ---\n" +
      "• **gras** pour chiffres, prix, noms de produits, contacts\n" +
      "• *italique* pour nuances ou exemples\n" +
      "• Listes à puces pour options, étapes, caractéristiques\n" +
      "• Sauts de ligne entre les paragraphes\n" +
      "• Émojis discrets et utiles (📞 téléphone, 📧 email, 💰 prix, 📦 livraison, ✅ confirmation)\n" +
      "• `code` pour adresses email, numéros techniques\n" +
      "\n" +
      "⚡ RÈGLE #6 — COORDONNÉES : UNIQUEMENT DEPUIS LE CONTEXTE\n" +
      "Les numéros de téléphone, emails, adresses, horaires et liens :\n" +
      "→ tu ne dois LES ÉCRIRE que s'ils apparaissent **textuellement** dans le contexte [Source N].\n" +
      "→ N'invente JAMAIS un numéro de téléphone, un email ou une adresse.\n" +
      "→ Si le contexte ne contient pas l'info demandée, dis-le clairement :\n" +
      "  « Nous ne trouvons pas de numéro de téléphone dans nos documents. Puis-je vous aider avec autre chose ? »\n" +
      "\n" +
      "--- CAS PARTICULIER : HORS CONTEXTE ---\n" +
      "Si la question du visiteur ne correspond à AUCUN document fourni :\n" +
      "  → « Désolée, je n'ai pas d'information sur ce sujet dans notre base. Je vous invite à contacter notre équipe qui pourra vous répondre précisément. » (et uniquement si un moyen de contact existe dans le contexte).\n" +
      "Ne comble JAMAIS le vide avec du contenu inventé ou générique.",
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
