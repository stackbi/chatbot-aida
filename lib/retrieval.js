// Recherche de contexte (RAG) par correspondance de mots-clés / fréquence de termes.
// Aucun appel API externe : tout le matching est fait en local par tokenization et scoring
// de fréquence. Pour un site avec beaucoup de contenu (>200 pages), on peut plus tard
// remplacer ceci par une vraie recherche vectorielle (base de données vectorielle).

const STOPWORDS = new Set([
  "les", "des", "une", "un", "le", "la", "de", "du", "et", "est", "en",
  "que", "qui", "pour", "dans", "sur", "avec", "au", "aux", "ce", "ces",
  "son", "sa", "ses", "il", "elle", "nous", "vous", "ils", "elles",
  "mon", "ma", "mes", "ton", "ta", "tes", "notre", "votre", "leur",
  "pas", "plus", "comme", "mais", "ou", "où", "donc", "car", "ni",
  "être", "avoir", "fait", "faire", "cette", "cet", "tout", "tous",
  "toute", "toutes", "par", "sans", "sous", "vers", "chez", "quand",
  "the", "and", "for", "are", "with", "this", "that", "from", "have"
]);

function tokenize(text) {
  if (!text || typeof text !== "string") return [];
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // enlève les accents
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * Retourne les topK passages les plus pertinents par rapport à la question posée.
 */
export function retrieveRelevantChunks(documents, query, topK = 4) {
  if (!query || typeof query !== "string") return [];
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0 || !documents || documents.length === 0) return [];

  const scored = [];

  for (const doc of documents) {
    if (!doc || !doc.chunks) continue;
    for (const chunk of doc.chunks) {
      if (!chunk || typeof chunk !== "string") continue;
      const chunkTerms = tokenize(chunk);
      if (chunkTerms.length === 0) continue;

      const freq = {};
      for (const t of chunkTerms) freq[t] = (freq[t] || 0) + 1;

      let score = 0;
      for (const qt of queryTerms) {
        if (freq[qt]) {
          // légère pondération inverse à la longueur du chunk pour éviter
          // que les très longs passages dominent artificiellement
          score += freq[qt] / Math.sqrt(chunkTerms.length);
        }
      }

      if (score > 0) {
        scored.push({ score, chunk, title: doc.title || "Sans titre" });
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/**
 * Construit le bloc de contexte à injecter dans le system prompt.
 */
export function buildContextBlock(relevantChunks) {
  if (!relevantChunks || relevantChunks.length === 0) return "";
  const parts = relevantChunks.map(
    (r, i) => `[Source ${i + 1} — ${r.title}]\n${r.chunk}`
  );
  return `\n\nCONTEXTE DU SITE (utilise-le en priorité pour répondre) :\n${parts.join(
    "\n\n"
  )}`;
}
