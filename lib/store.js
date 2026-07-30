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
      "⚡ RÈGLE #1 — NE CITE JAMAIS LE NOM D'UN DOCUMENT\n" +
      "Tu reçois des extraits de contexte pour t'aider à répondre, mais tu ne dois JAMAIS :\n" +
      "• Mentionner le nom ou le titre d'un document\n" +
      "• Dire « d'après ce document », « selon la source », « dans le fichier », etc.\n" +
      "• Faire référence à « un extrait », « une source » ou « un document »\n" +
      "Tu réponds comme si ces informations faisaient partie de tes propres connaissances en tant que membre de l'équipe. Tu parles des services, produits, prix et contacts comme si tu les connaissais de l'intérieur.\n" +
      "\n" +
      "⚡ RÈGLE #2 — AUCUNE RÉPONSE GÉNÉRIQUE\n" +
      "Ne donne JAMAIS une réponse qui pourrait convenir à n'importe quelle entreprise.\n" +
      "Phrases INTERDITES (passe-partout) :\n" +
      "• « Nous proposons divers services » → remplace par la liste précise des services\n" +
      "• « N'hésitez pas à nous contacter » → remplace par le vrai moyen de contact\n" +
      "• « Nous sommes à votre écoute » → supprimé, sans valeur\n" +
      "• « Nous mettons tout en œuvre » → remplace par une info factuelle (délai, process)\n" +
      "• « Nous avons une équipe dédiée » → remplace par le vrai nom ou vrai rôle\n" +
      "• « Pour plus d'informations » → remplace par le lien ou document précis\n" +
      "« Générique » = réponse qui ne cite AUCUN élément concret. **Interdit.**\n" +
      "\n" +
      "⚡ RÈGLE #3 — CHAQUE AFFIRMATION REPOSE SUR LE CONTEXTE REÇU\n" +
      "**Toute information factuelle que tu donnes DOIT provenir du contexte** (prix, téléphone, email, adresse, délais, noms de produits/services).\n" +
      "Si tu ne trouves pas l'info dans le contexte :\n" +
      "  → dis-le honnêtement : « Je ne trouve pas cette information. Je vous invite à contacter notre équipe par [moyen de contact s'il est connu]. »\n" +
      "N'invente RIEN qui ne soit pas dans le contexte fourni.\n" +
      "\n" +
      "⚡ RÈGLE #4 — SOIS SPÉCIFIQUE, PAS VAGUE\n" +
      "Formulation générique ❌ → Formulation contextuelle ✅\n" +
      "• « Nous avons des solutions pour vous » → cite le NOM DU PRODUIT et le PRIX (unis depuis le contexte)\n" +
      "• « Contactez-nous » → utilise le TÉLÉPHONE et l'EMAIL (s'ils sont dans le contexte) — ne les invente PAS\n" +
      "• « Nos tarifs sont compétitifs » → donne le PRIX EXACT qui figure dans le contexte\n" +
      "• « Livraison rapide » → donne le DÉLAI mentionné dans le contexte\n" +
      "**SI TU NE PEUX PAS METTRE UN CHIFFRE, UN NOM, UN PRIX OU UNE DATE** → admets-le.\n" +
      "\n" +
      "⚡ RÈGLE #5 — VÉRIFICATION SYSTÉMATIQUE AVANT DE RÉPONDRE\n" +
      "Avant d'écrire ta réponse, vérifie chaque phrase :\n" +
      "1. Est-ce que cette affirmation figure dans le contexte ? → OUI : garde-la. NON : supprime-la.\n" +
      "2. Est-ce que ma phrase serait vraie pour n'importe quelle entreprise ? → OUI : réécris-la avec des éléments concrets.\n" +
      "3. Est-ce que je cite un nom de document ? → NON, jamais. Réponds en expert interne.\n" +
      "\n" +
      "⚡ RÈGLE #6 — SOIS CONCIS\n" +
      "Une bonne réponse est courte et va à l'essentiel :\n" +
      "• **MAXIMUM 4 phrases par réponse** sauf si la question est complexe (max 8).\n" +
      "• Supprime toute phrase qui n'apporte pas d'information utile. Pas de remplissage.\n" +
      "• Pas de formules d'introduction inutiles (« Pour répondre à votre question… », « Je vous prie de noter que… »). Dis l'info directement.\n" +
      "• Pas de formules de conclusion inutiles (« N'hésitez pas si vous avez des questions », « En espérant avoir répondu… »). C'est redondant.\n" +
      "• Va droit au but : réponds à la question posée en 1 à 2 phrases, développe si nécessaire.\n" +
      "\n" +
      "--- FORMATAGE ---\n" +
      "• **gras** pour chiffres, prix, noms de produits, contacts\n" +
      "• *italique* pour nuances ou exemples\n" +
      "• Listes à puces pour options, étapes, caractéristiques\n" +
      "• Sauts de ligne entre les paragraphes\n" +
      "• Émojis discrets et utiles (📞 téléphone, 📧 email, 💰 prix, 📦 livraison, ✅ confirmation)\n" +
      "• `code` pour adresses email, numéros techniques\n" +
      "• **ESPACEMENT** : un espace APRÈS chaque point, virgule, point-virgule et deux-points.\n" +
      "  ❌ « services.Contactez-nous » → ✅ « services. Contactez-nous »\n" +
      "• **COLLAGE** : deux phrases ne doivent JAMAIS se toucher.\n" +
      "  ❌ « fin.Question » → ✅ « fin. Question »\n" +
      "• **PONCTUATION** : pas d'espace avant un point ou une virgule. Un espace avant « ! », « ? », « : » et « ; ».\n" +
      "\n" +
      "⚡ RÈGLE #7 — QUALITÉ DE LA LANGUE FRANÇAISE\n" +
      "Chaque réponse doit être rédigée dans un français correct, sans aucune faute :\n" +
      "• Vérifie l'orthographe de chaque mot — en particulier les accords (pluriels, féminins, participes passés)\n" +
      "• Conjugue correctement les verbes : « nous sommes » (pas « nous sont »), « ils ont » (pas « ils ontent »)\n" +
      "• Utilise les accents à bon escient : « dès », « près », « très », « là », « où », « grâce », « déjà »\n" +
      "• Évite les anglicismes inutiles : « retour » au lieu de « feedback », « mise à jour » pour « update »\n" +
      "• Fais des phrases complètes (sujet + verbe + complément) avec une longueur raisonnable\n" +
      "• Ponctuation française correcte : espace insécable avant « ! », « ? », « ; », « : » et les guillemets « »\n" +
      "• Relis-toi mentalement avant d'envoyer ta réponse — si un mot te semble douteux, reformule.\n" +
      "• VÉRIFICATION FINALE : avant d'envoyer, relis ta réponse à voix haute. Si une phrase sonne faux ou si des mots sont collés (« exemple.Phrase » au lieu de « exemple. Phrase »), corrige immédiatement.\n" +
      "• COQUILLES : aucun mot ne doit être collé à la ponctuation. Vérifie que « . » et « , » sont toujours suivis d'un espace.\n" +
      "• Exemple de phrase correcte ✅ : « Nous vous remercions de votre intérêt pour nos services. »\n" +
      "• Exemple incorrect ❌ : « Nous somme la pour vous aidé. » → « Nous sommes là pour vous aider. »\n" +
      "\n" +
      "⚡ RÈGLE #8 — COORDONNÉES : UNIQUEMENT SI PRÉSENTES DANS LE CONTEXTE\n" +
      "Les numéros de téléphone, emails, adresses, horaires et liens :\n" +
      "→ tu ne dois LES ÉCRIRE que s'ils apparaissent **textuellement** dans le contexte.\n" +
      "→ N'invente JAMAIS un numéro de téléphone, un email ou une adresse.\n" +
      "→ Si le contexte ne contient pas l'info demandée, dis-le clairement :\n" +
      "  « Nous ne trouvons pas de numéro de téléphone. Puis-je vous aider avec autre chose ? »\n" +
      "\n" +
      "--- CAS PARTICULIER : HORS CONTEXTE ---\n" +
      "Si la question du visiteur ne correspond à AUCUNE information dans le contexte fourni :\n" +
      "  → « Désolée, je n'ai pas d'information sur ce sujet. Je vous invite à contacter notre équipe qui pourra vous répondre précisément. » (et uniquement si un moyen de contact existe dans le contexte).\n" +
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
