/**
 * Recherche de contexte (RAG) — hybride vectoriel + mots-clés
 *
 * Pipeline :
 *   1. Recherche vectorielle (similarité cosinus sur embeddings all-MiniLM-L6-v2)
 *   2. Fallback mots-clés (tokenization TF normalisée) si pas d'embeddings dispo
 *
 * Les embeddings des documents sont pré-calculés au moment de l'ajout du document
 * (voir lib/store.js). Seul l'embedding de la requête utilisateur est calculé
 * à la volée via le modèle local (gratuit, sans API externe).
 */

import {
  generateEmbedding,
  findSimilarChunks
} from "./embedding.js";

// ── Stopwords (inchangé depuis l'ancien système de mots-clés) ──────────
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
 * Recherche par mots-clés (fallback quand les embeddings ne sont pas disponibles).
 * Scoring par fréquence de termes pondérée par la longueur du chunk.
 */
function keywordSearch(documents, query, topK = 4) {
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
 * Retourne les topK passages les plus pertinents par rapport à la question posée.
 *
 * Utilise la recherche vectorielle (embeddings) si disponible,
 * sinon tombe sur la recherche par mots-clés.
 *
 * @param {Array} documents - Documents avec chunks et embeddings optionnels
 * @param {string} query - Question de l'utilisateur
 * @param {number} topK - Nombre de résultats (défaut: 4)
 * @returns {Promise<Array<{score:number, chunk:string, title:string}>>}
 */
export async function retrieveRelevantChunks(documents, query, topK = 4) {
  if (!query || typeof query !== "string" || !documents || documents.length === 0) {
    return [];
  }

  // ── Phase 1 : vérifier si on peut faire de la recherche vectorielle ──
  const hasEmbeddings = documents.some(
    (doc) => doc.embeddings && doc.embeddings.length > 0
  );

  if (hasEmbeddings) {
    try {
      // Calcul de l'embedding de la requête utilisateur
      const queryEmbedding = await generateEmbedding(query);
      if (queryEmbedding) {
        // Construit la liste plate de { chunk, embedding, title } pour tous les chunks
        const chunkEntries = [];
        for (const doc of documents) {
          if (doc.embeddings && doc.chunks) {
            for (let i = 0; i < doc.chunks.length; i++) {
              if (doc.embeddings[i]) {
                chunkEntries.push({
                  chunk: doc.chunks[i],
                  embedding: doc.embeddings[i],
                  title: doc.title || "Sans titre"
                });
              }
            }
          }
        }

        if (chunkEntries.length > 0) {
          const results = findSimilarChunks(queryEmbedding, chunkEntries, topK);
          if (results.length > 0) {
            console.log(`🔍 RAG vectoriel : ${results.length} chunks trouvés (best score: ${results[0].score.toFixed(3)})`);
            return results;
          }
        }
      }
    } catch (err) {
      console.warn("⚠️ Échec de la recherche vectorielle, fallback mots-clés:", err.message);
    }
  }

  // ── Phase 2 : fallback recherche par mots-clés ──
  console.log("🔍 RAG mots-clés (fallback)");
  return keywordSearch(documents, query, topK);
}

/**
 * Retourne les topK passages les plus pertinents en mode synchrone.
 * Utile quand l'appelant ne peut pas faire d'async (ex: anciens appels).
 * Utilise uniquement la recherche par mots-clés.
 */
export function retrieveRelevantChunksSync(documents, query, topK = 4) {
  return keywordSearch(documents, query, topK);
}

/**
 * Construit le bloc de contexte à injecter dans le system prompt du LLM.
 * Les documents sont anonymisés : le titre n'apparaît jamais,
 * seuls les extraits pertinents sont transmis.
 */
export function buildContextBlock(relevantChunks) {
  if (!relevantChunks || relevantChunks.length === 0) return "";
  const parts = relevantChunks.map(
    (r, i) => `[Extrait ${i + 1}]\n${r.chunk}`
  );
  return `\n\n« CONTEXTE OFFICIEL : toute réponse DOIT être basée exclusivement sur les informations ci-dessous. N'invente AUCUN téléphone, email, prix ou adresse. Ne mentionne JAMAIS le nom d'un document ou le mot « extrait ». »\n\n${parts.join("\n\n")}\n\nRAPPEL : si absent du contexte ci-dessus → ne pas inventer.`;
}
