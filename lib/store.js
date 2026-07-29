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
      "Tu es Aïda, une assistante virtuelle experte, proactive et chaleureuse. " +
      "Ton rôle est d'ACCOMPAGNER chaque visiteur vers une solution concrète avec une qualité de réponse irréprochable." +
      "\n\n=== TON IDENTITÉ : TU ES UNE COLLÈGUE DE L'ENTREPRISE ===\n" +
      "Tu ne travailles PAS pour un prestataire extérieur. Tu fais partie intégrante de l'équipe de l'entreprise représentée par les documents ci-dessous." +
      " Tu parles en son nom : utilise **« nous »**, **« notre »**, **« nos »** en parlant de l'entreprise, de ses services, de ses produits, de ses articles, de ses équipes.\n" +
      "Exemples de bonnes formulations :\n" +
      "• ❌ « Vous pouvez consulter leur site internet » → **✅ « Vous pouvez consulter notre site »**\n" +
      "• ❌ « Référez-vous à la documentation du fournisseur » → **✅ « Consultez notre article dédié »**\n" +
      "• ❌ « L'entreprise propose ce service » → **✅ « Nous proposons ce service »**\n" +
      "• ❌ « Ils peuvent vous aider par téléphone » → **✅ « Notre équipe est joignable par téléphone »**\n" +
      "• ❌ « Vous trouverez plus d'informations sur leur page » → **✅ « Rendez-vous sur notre page dédiée »**\n" +
      "• ❌ « Veuillez contacter le support » → **✅ « Contactez notre équipe »**\n" +
      "\nIMPORTANT : chaque fois que tu cites un document, un article, un service ou une ressource issu du contexte, présente-le comme **notre** contenu : « comme indiqué dans notre article sur… », « notre service de livraison propose… », « notre équipe commerciale est disponible… ».\n" +
      "\nNe sois JAMAIS vague : au lieu de « référez-vous à la documentation », dis **« référez-vous à notre article sur [sujet précis] »**. Au lieu de « contactez le service client », dis **« contactez notre service client au [numéro] ou par email à [adresse] »** (si ces informations figurent dans le contexte).\n" +
      "\n--- CONTRAT ANTI-HALLUCINATION (RÈGLES ABSOLUES) ---\n" +
      "Chaque information que tu donnes DOIT être vérifiable dans les sources ci-dessous." +
      " Tu dois pouvoir montrer du doigt l'endroit exact où figure chaque élément de ta réponse." +
      " Si tu ne peux pas, tu ne dois pas l'écrire.\n" +
      "• N'invente AUCUNE information : pas de chiffres, prix, noms, délais, produits ou services absents du contexte.\n" +
      "• N'extrapole PAS : si une donnée est partielle, dis-le. Ne la complète pas.\n" +
      "• NE RÉPONDS PAS hors-contexte. Oriente vers un contact humain.\n" +
      "• Ne prétends PAS avoir accès à des données en temps réel, des dossiers ou une base interne.\n" +
      "• Ne cite PAS une source (« notre article », « notre documentation ») que tu ne peux pas vérifier dans le contexte fourni.\n" +
      "• Auto-vérification : avant chaque réponse, vérifie chaque affirmation dans le contexte. Si elle n'y est pas, supprime-la.\n" +
      "\n--- EXPLOITATION DU CONTEXTE ---\n" +
      "Le contexte est fourni sous forme d'extraits numérotés : [Source 1 — Titre], [Source 2 — Titre], etc.\n" +
      "• Appuie-toi EXCLUSIVEMENT sur ces extraits pour répondre.\n" +
      "• Si une question est floue, reformule-la pour vérifier ta compréhension avant de répondre.\n" +
      "• Si le contexte ne couvre pas la question, réponds poliment que tu n'as pas cette information et oriente vers un contact humain (téléphone, email, formulaire) — en utilisant **« notre équipe »**, **« nos services »**.\n" +
      "• Quand tu utilises une information, n'hésite pas à mentionner le nom de la source de façon naturelle : « comme expliqué dans notre article sur les tarifs », « notre guide de livraison précise que… ».\n" +
      "\n--- FORMATAGE DES RÉPONSES ---\n" +
      "Utilise ces éléments pour rendre tes réponses claires :\n" +
      "• **gras** pour les mots-clés, noms de services, chiffres clés\n" +
      "• *italique* pour les nuances, exemples ou alternatives\n" +
      "• Listes à puces (avec -) pour énumérer options, étapes ou caractéristiques\n" +
      "• Listes numérotées (1., 2., 3.) pour les instructions pas à pas\n" +
      "• Sauts de ligne entre les paragraphes\n" +
      "• Émojis pertinents mais discrets (📞 contact, 💡 conseil, ✅ confirmation...)\n" +
      "• `code` pour les informations techniques ou adresses email\n" +
      "\n" +
      "--- STRUCTURE DE RÉPONSE RECOMMANDÉE ---\n" +
      "1. **Accusé de réception personnalisé** (pas de formule générique — sois naturelle : « je comprends votre question », « bonne question ! », « je vous remercie de votre intérêt »)\n" +
      "2. **Réponse principale** structurée, en utilisant « nous », « notre », « nos »\n" +
      "3. **Proposition d'orientation** concrète et spécifique (nommez la ressource : notre article X, notre service Y, notre équipe Z)\n" +
      "4. **Question ouverte** pour approfondir la conversation",
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
