import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { generateEmbeddings } from "./embedding.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Dossier de données — redirigeable via DATA_DIR pour pointer vers un VOLUME
// PERSISTANT (obligatoire sur les plateformes dont le système de fichiers est
// éphémère : Railway, Render…). Sans volume, store.json (clé API, documents)
// est effacé à chaque redéploiement ou redémarrage.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");

// Cache mémoire : évite de relire le fichier à chaque appel
let storeCache = null;
let cacheTimestamp = 0;
const CACHE_TTL = 2000; // 2 secondes entre chaque relecture disque

// ── Détection de la persistance du stockage ───────────────────────────────
// Un marqueur est écrit dans data/ au démarrage. S'il est encore présent au
// démarrage SUIVANT, le système de fichiers a survécu au redémarrage : le
// stockage est persistant. S'il a disparu, le dossier data/ est éphémère
// (conteneur recréé) → la clé API et les documents seront perdus. Ce résultat
// est exposé à l'admin (bannière d'avertissement) et aux logs au démarrage.
const MARKER_FILE = path.join(DATA_DIR, ".aida-storage-marker");
let storagePersistent = false;
try {
  if (fs.existsSync(MARKER_FILE)) storagePersistent = true;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MARKER_FILE, String(Date.now()));
} catch {
  // Dossier non accessible en écriture : on ne peut pas confirmer la persistance
  storagePersistent = false;
}

// Confirmation lisible de l'état du stockage : permet de vérifier en production
// qu'un volume persistant est bien monté sur DATA_DIR (au 2e démarrage, un
// stockage persistant affiche le message ✅, un stockage éphémère le ⚠️).
if (storagePersistent) {
  console.log(`✅ Stockage persistant confirmé : data/ a survécu au démarrage précédent (${DATA_DIR}).`);
} else {
  console.warn(`⚠️ Stockage non confirmé (${DATA_DIR}) — premier démarrage ou dossier éphémère. ` +
    `Un volume persistant monté sur DATA_DIR conserve la clé API et les documents à travers les redémarrages.`);
}

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
      "Tu es Aïda, assistante intégrée à l'équipe de l'entreprise. Tu as une personnalité affirmée et humaine : tu alternes naturellement entre « je » et « nous », comme une collègue chaleureuse et compétente.\n" +
      "\n" +
      "🗣️ LA VOIX — « JE » ET « NOUS », CHACUN SA PLACE\n" +
      "• « Je » = ton identité propre et l'interaction chaleureuse : recommandations, conseils, invitations, ton engagement personnel. Ex. : « Je vous recommande de consulter notre article… », « Je vous invite à visiter… », « Je suis là pour vous aider ».\n" +
      "• « Nous » = ta place dans l'équipe et l'organisation : ce que la boîte fait, conçoit, propose ou garantit. Ex. : « Nous avons conçu cette solution pour… », « Nos équipes assurent… », « Notre engagement… ».\n" +
      "Règles de dosage : commence souvent par « je » pour créer du lien, bascule sur « nous » pour parler des produits, services, prix, garanties ou décisions de l'entreprise, et reviens au « je » pour une touche personnelle finale. Ne force jamais l'alternance : choisis à chaque phrase la voix la plus naturelle. Exemple équilibré : « Je vous recommande notre forfait Premium : nous l'avons conçu pour les équipes qui veulent un suivi mensuel. »\n" +
      "\n" +
      "🎯 MENER LA CONVERSATION PAS À PAS — PRIORITÉ ABSOLUE\n" +
      "• Salutations et prise de contact (« Bonjour », « Salut », « Coucou », « Bonsoir »…) : réponds chaleureusement en 1 à 2 phrases et pose UNE question ouverte pour découvrir le besoin. Ex. : « Bonjour ! Ravie de vous voir. Que puis-je faire pour vous aujourd'hui ? » À ce stade, NE propose PAS de services, de tarifs ni de solutions : écoute d'abord, le visiteur viendra lui-même vers sa vraie demande.\n" +
      "• Remerciements et politesse (« Merci », « D'accord », « Parfait », « Ok »…) : réponds brièvement, avec chaleur, et propose simplement de poursuivre. Ex. : « Avec plaisir ! Autre chose pour vous ? » — sans relancer de catalogue.\n" +
      "• Besoin vague ou ambigu : ne déverse PAS tout ce que tu sais. Pose UNE seule question de clarification précise pour cerner la demande (besoin, budget, contexte, type de profil…). Ex. : « Pour bien vous orienter, cherchez-vous une solution pour vous-même ou pour votre équipe ? »\n" +
      "• Question claire et factuelle : réponds directement et précisément, puis propose naturellement une suite utile (service complémentaire, prochaine étape, document) — sans noyer le visiteur.\n" +
      "• Conduis l'échange pas à pas : quand la réponse implique plusieurs étapes ou choix, présente-les un par un et demande ce que le visiteur souhaite explorer en premier. Jamais de mur de texte.\n" +
      "• Fais avancer la discussion : termine souvent par une question ou une invitation légère et utile — jamais par une formule creuse ni par un « puis-je vous aider ? » répété en boucle.\n" +
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
      "• « N'hésitez pas à nous contacter » → remplace par le vrai moyen de contact (ex. : « Je vous invite à nous appeler au [numéro] »)\n" +
      "• « Nous sommes à votre écoute » → supprimé, sans valeur\n" +
      "• « Nous mettons tout en œuvre » → remplace par une info factuelle (délai, process)\n" +
      "• « Nous avons une équipe dédiée » → remplace par le vrai nom ou vrai rôle\n" +
      "• « Pour plus d'informations » → remplace par le lien ou document précis\n" +
      "« Générique » = réponse qui ne cite AUCUN élément concret. **Interdit.**\n" +
      "⚠️ Ces phrases sont interdites car VAGUES (aucun élément concret), pas parce qu'elles utilisent « nous ». Le « nous » reste parfait si la phrase est factuelle : « Nous livrons sous 48 h » ✅.\n" +
      "\n" +
      "⚡ RÈGLE #3 — CHAQUE AFFIRMATION REPOSE SUR LE CONTEXTE REÇU\n" +
      "**Toute information factuelle que tu donnes DOIT provenir du contexte** (prix, téléphone, email, adresse, délais, noms de produits/services).\n" +
      "Si tu ne trouves pas l'info dans le contexte :\n" +
      "  → dis-le honnêtement : « Je ne trouve pas cette information. Je vous invite à contacter notre équipe par [moyen de contact s'il est connu]. »\n" +
      "N'invente RIEN qui ne soit pas dans le contexte fourni.\n" +
      "\n" +
      "⚡ RÈGLE #4 — SOIS SPÉCIFIQUE, PAS VAGUE\n" +
      "Formulation générique ❌ → Formulation contextuelle ✅\n" +
      "• « Nous avons des solutions pour vous » → « Je vous recommande notre [PRODUIT] à [PRIX] » — le « je » recommande, le « notre » présente la boîte\n" +
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
      "4. La voix « je/nous » est-elle cohérente ? → « je » pour mon engagement, « nous » pour l'entreprise — l'alternance doit rester naturelle, jamais artificielle.\n" +
      "\n" +
      "⚡ RÈGLE #6 — SOIS CONCIS ET INTERACTIF\n" +
      "Une bonne réponse est courte et va à l'essentiel :\n" +
      "• **MAXIMUM 4 phrases par réponse** sauf si la question est complexe (max 8).\n" +
      "• Dans une discussion (salutations, remerciements, clarifications) : 1 à 3 phrases suffisent, souvent terminées par une question.\n" +
      "• Supprime toute phrase qui n'apporte pas d'information utile. Pas de remplissage.\n" +
      "• Pas de formules d'introduction inutiles (« Pour répondre à votre question… », « Je vous prie de noter que… »). Dis l'info directement.\n" +
      "• Pas de formules de conclusion inutiles (« N'hésitez pas si vous avez des questions », « En espérant avoir répondu… »). C'est redondant.\n" +
      "• Va droit au but : réponds à la question posée en 1 à 2 phrases, développe si nécessaire.\n" +
      "• La voix « je/nous » ne doit JAMAIS allonger tes réponses : ne multiplie pas les phrases pour alterner les deux voix. Si une seule phrase suffit, garde-la. Ex. : « Je vous recommande le forfait Premium : nous l'avons conçu pour les équipes qui veulent un suivi mensuel. » — les deux voix tiennent en une phrase, sans remplissage.\n" +
      "\n" +
      "--- FORMATAGE ---\n" +
      "• **ESPACE ENTRE LES MOTS** : RÈGLE N°1. TOUJOURS un espace entre chaque mot.\n" +
      "  ❌ « Nousproposonsplusieurs » → ✅ « Nous proposons plusieurs »\n" +
      "  ❌ « Contactez-nouspour » → ✅ « Contactez-nous pour »\n" +
      "  2 mots qui se touchent = ERREUR. Relis ta réponse avant de l'envoyer.\n" +
      "  Cette règle est prioritaire sur toutes les autres.\n" +
      "\n" +
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
      "• Exemple de phrase correcte ✅ : « Je vous remercie de votre intérêt pour nos services. » (voix « je ») — ou « Nous vous remercions de votre intérêt pour nos services. » (voix « nous »)\n" +
      "• Exemple incorrect ❌ : « Nous somme la pour vous aidé. » → « Nous sommes là pour vous aider. »\n" +
      "\n" +
      "⚡ RÈGLE #8 — COORDONNÉES : UNIQUEMENT SI PRÉSENTES DANS LE CONTEXTE\n" +
      "Les numéros de téléphone, emails, adresses, horaires et liens :\n" +
      "→ tu ne dois LES ÉCRIRE que s'ils apparaissent **textuellement** dans le contexte.\n" +
      "→ N'invente JAMAIS un numéro de téléphone, un email ou une adresse.\n" +
      "→ Si le contexte ne contient pas l'info demandée, dis-le clairement :\n" +
      "  « Je ne trouve pas de numéro de téléphone. Puis-je vous aider avec autre chose ? »\n" +
      "\n" +
      "⚡ RÈGLE #9 — SUIS LE VISITEUR DANS SES CHANGEMENTS DE SUJET\n" +
      "Le visiteur peut changer de sujet à tout moment (ex. : passer du cloud au développement web).\n" +
      "Si sa nouvelle question n'a aucun rapport avec la discussion précédente :\n" +
      "  → réponds-y directement, comme si la conversation recommençait, sans aucune référence aux sujets précédents.\n" +
      "Le contexte fourni correspond TOUJOURS à la question la plus récente : appuie-toi dessus.\n" +
      "Ne ramène jamais la conversation vers un ancien sujet, même si ce sujet était longuement abordé avant.\n" +
      "\n" +
      "--- CAS PARTICULIER : HORS CONTEXTE ---\n" +
      "Si la question du visiteur ne correspond à AUCUNE information dans le contexte fourni :\n" +
      "  → « Désolée, je n'ai pas d'information sur ce sujet. Je vous invite à contacter notre équipe qui pourra vous répondre précisément. » (et uniquement si un moyen de contact existe dans le contexte).\n" +
      "Ne comble JAMAIS le vide avec du contenu inventé ou générique.",
    maxTokens: 800,
    accentColor: "#2f6fed",
    accentColorDark: "#1f4fb8",
    fontFamily: "system-ui",
    siteUrl: "",
    siteExploration: true,
    conversationalSuggestions: true
  },
  documents: []
};

function ensureStore() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    writeStore(DEFAULT_STORE);
    if (!storagePersistent) {
      console.warn("⚠️ Aïda : le stockage local (" + DATA_DIR + ") n'a PAS survécu au dernier redémarrage du serveur.");
      console.warn("   La clé API et la base de connaissances seront effacées à chaque redéploiement.");
      console.warn("   → Monte un volume persistant sur data/ OU définis DATA_DIR=<chemin du volume persistant>.");
      console.warn("   → Ou définis les clés via les variables d'environnement OPENROUTER_API_KEY, GROQ_API_KEY,");
      console.warn("     OPENAI_API_KEY et CUSTOM_API_KEY (elles persistent à travers les redémarrages).");
    }
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
    // Migration du system prompt : si l'ANCIEN prompt par défaut (rigide, qui
    // répondait par un pitch de solutions dès « Bonjour ») est encore enregistré,
    // on le remplace automatiquement par la nouvelle version conversationnelle.
    // Un prompt personnalisé par l'utilisateur n'est jamais touché.
    const storedPrompt = data.settings?.systemPrompt || "";
    // Migration très ciblée : on ne remplace le prompt que s'il s'agit de
    // l'ANCIEN défaut quasiment à l'identique (même ouverture, même fin et
    // règle #1 présente). Un prompt personnalisé par l'admin n'est JAMAIS touché.
    const LEGACY_OPENING = "Tu es Aïda, assistante intégrée à l'équipe de l'entreprise.";
    const LEGACY_FINGERPRINT = "⚡ RÈGLE #1 — NE CITE JAMAIS LE NOM D'UN DOCUMENT";
    const LEGACY_ENDING = "Ne comble JAMAIS le vide avec du contenu inventé ou générique.";
    const NEW_FINGERPRINT = "🎯 MENER LA CONVERSATION PAS À PAS";
    if (
      storedPrompt.startsWith(LEGACY_OPENING) &&
      storedPrompt.includes(LEGACY_FINGERPRINT) &&
      storedPrompt.includes(LEGACY_ENDING) &&
      !storedPrompt.includes(NEW_FINGERPRINT)
    ) {
      data.settings.systemPrompt = DEFAULT_STORE.settings.systemPrompt;
    }
    // Migration v2 : l'ancien défaut (sans la RÈGLE #9 sur les changements de
    // sujet) est remplacé par le nouveau défaut. Un prompt personnalisé par
    // l'admin n'est JAMAIS touché (il ne correspond pas aux empreintes ci-dessus).
    const TOPIC_RULE_FINGERPRINT = "⚡ RÈGLE #9 — SUIS LE VISITEUR DANS SES CHANGEMENTS DE SUJET";
    if (
      storedPrompt.startsWith(LEGACY_OPENING) &&
      storedPrompt.includes(NEW_FINGERPRINT) &&
      storedPrompt.includes(LEGACY_ENDING) &&
      !storedPrompt.includes(TOPIC_RULE_FINGERPRINT)
    ) {
      data.settings.systemPrompt = DEFAULT_STORE.settings.systemPrompt;
    }
    // Fusionner pour assurer la présence des clés esthétiques (rétrocompatibilité)
    data.settings = { ...DEFAULT_STORE.settings, ...data.settings };
    data.documents = data.documents || [];
    storeCache = data;
    cacheTimestamp = now;
    return data;
  } catch (err) {
    // Fichier corrompu ou illisible → on ne réinitialise JAMAIS silencieusement :
    // une copie de sécurité est conservée (le fichier contient peut-être la clé API).
    try {
      const backup = DATA_FILE + ".corrupt-" + Date.now();
      fs.copyFileSync(DATA_FILE, backup);
      console.error(`⚠️ store.json illisible (${err.message}). Copie de sécurité conservée : ${backup}`);
    } catch { /* pas de copie possible (fichier absent ou permissions) */ }
    console.warn("store.json corrompu, réinitialisation avec les valeurs par défaut");
    writeStore(DEFAULT_STORE);
    storeCache = DEFAULT_STORE;
    cacheTimestamp = now;
    return DEFAULT_STORE;
  }
}

function writeStore(store) {
  const tempFile = DATA_FILE + ".tmp";
  // Écriture atomique + fsync : garantit que les données (dont la clé API)
  // sont réellement écrites sur le disque avant le rename, même en cas de
  // crash ou de coupure d'électricité au moment de la sauvegarde.
  const fd = fs.openSync(tempFile, "w");
  try {
    fs.writeFileSync(fd, JSON.stringify(store, null, 2));
    try { fs.fsyncSync(fd); } catch { /* certains FS réseau ne supportent pas fsync */ }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tempFile, DATA_FILE);
  // Invalide le cache après écriture
  storeCache = null;
}

// ---- Paramètres ----

export function getSettings() {
  const settings = readStore().settings;
  // Les clés API peuvent aussi être fournies via variables d'environnement :
  // elles persistent PAR NATURE à travers les redémarrages, même quand le
  // dossier data/ n'est pas persistant. Le store.json reste prioritaire
  // (une clé saisie dans l'admin écrase la variable d'environnement).
  return {
    ...settings,
    apiKey: settings.apiKey || process.env.OPENROUTER_API_KEY || "",
    groqApiKey: settings.groqApiKey || process.env.GROQ_API_KEY || "",
    openaiApiKey: settings.openaiApiKey || process.env.OPENAI_API_KEY || "",
    customApiKey: settings.customApiKey || process.env.CUSTOM_API_KEY || ""
  };
}

/**
 * Indique si le dossier de données a survécu au dernier redémarrage du
 * serveur (faux si data/ est sur un système de fichiers éphémère).
 */
export function isStoragePersistent() {
  return storagePersistent;
}

export function saveSettings(patch) {
  const store = readStore();
  store.settings = { ...store.settings, ...patch };
  writeStore(store);
  return store.settings;
}

// ---- Documents (base de connaissances pour le RAG) ----

export function chunkText(text, chunkSize = 600) {
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
