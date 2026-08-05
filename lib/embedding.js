/**
 * Module d'embedding vectoriel local
 *
 * Utilise @huggingface/transformers pour charger un modèle d'embedding
 * (all-MiniLM-L6-v2, 384 dimensions, ~23 Mo) et générer des
 * représentations vectorielles du texte.
 *
 * Tout est exécuté en local – aucune clé API externe nécessaire.
 * Les embeddings sont générés une seule fois lors de l'ajout du
 * document, puis stockés dans store.json, et seulement l'embedding
 * de la requête de l'utilisateur est calculé à la volée.
 */

import { pipeline } from "@huggingface/transformers";

// ── Modèle d'embedding ────────────────────────────────────────────────
// all-MiniLM-L6-v2 : excellent rapport qualité/taille (384 dimensions)
const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";

// Cache du pipeline (chargé une seule fois)
let embeddingPipeline = null;
// Promesse partagée du chargement en cours : évite qu'une requête arrivant
// pendant le préchargement (au démarrage) lance un second chargement concurrent.
let embeddingLoading = null;

/**
 * Garantit que le pipeline d'embedding est chargé (lazy init).
 * Peut être appelé explicitement pour précharger le modèle.
 *
 * Les appels concurrents partagent la même promesse (in-flight) :
 * un seul chargement du modèle a lieu, les autres attendent le même résultat.
 */
export async function ensureEmbeddingModel() {
  if (embeddingPipeline) return embeddingPipeline;

  if (!embeddingLoading) {
    console.log("🧠 Chargement du modèle d'embedding…");
    embeddingLoading = pipeline("feature-extraction", MODEL_NAME)
      .then((pipe) => {
        embeddingPipeline = pipe;
        console.log("✅ Modèle d'embedding chargé");
        return pipe;
      })
      .catch((err) => {
        // Échec : libère la promesse partagée pour permettre une nouvelle tentative
        embeddingLoading = null;
        throw err;
      });
  }

  return embeddingLoading;
}

/**
 * Extrait l'embedding individuel (vecteur de 384 float) depuis le tenseur
 * de sortie du pipeline, à l'indice donné dans le batch.
 */
function extractEmbedding(tensor, index = 0) {
  // Le tenseur a une shape [batch, embedding_dim] après pooling
  const dim = tensor.dims[1]; // 384 pour all-MiniLM-L6-v2
  const offset = index * dim;
  return Array.from(tensor.data.slice(offset, offset + dim));
}

/**
 * Retourne l'embedding d'un texte sous forme de tableau de nombres.
 * Le pipeline est chargé paresseusement (lazy) au premier appel.
 */
export async function generateEmbedding(text) {
  if (!text || typeof text !== "string" || !text.trim()) {
    return null;
  }

  await ensureEmbeddingModel();

  try {
    // pooling: 'mean' → moyenne des tokens, normalize: true → vecteur unitaire
    const result = await embeddingPipeline(text, { pooling: "mean", normalize: true });
    return extractEmbedding(result, 0);
  } catch (err) {
    console.error("❌ Erreur lors de la génération d'embedding:", err.message);
    return null;
  }
}

/**
 * Génère les embeddings pour plusieurs textes en une passe (batch).
 * Retourne un tableau de vecteurs (Array<number[]> ou null pour les textes vides).
 */
export async function generateEmbeddings(texts) {
  if (!texts || texts.length === 0) return [];

  await ensureEmbeddingModel();

  // Sépare les textes valides des vides, garde la trace des indices d'origine
  const validTexts = [];
  const validIndices = [];
  for (let i = 0; i < texts.length; i++) {
    if (texts[i] && typeof texts[i] === "string" && texts[i].trim()) {
      validTexts.push(texts[i].trim());
      validIndices.push(i);
    }
  }

  // Initialise le tableau résultat avec des null pour tous
  const results = new Array(texts.length).fill(null);

  if (validTexts.length === 0) return results;

  try {
    // Le batch retourne un tenseur unique de shape [batch_size, embedding_dim]
    const batchResult = await embeddingPipeline(validTexts, {
      pooling: "mean",
      normalize: true,
    });

    // Extrait chaque vecteur du batch (shape: [batch_size, 384])
    for (let i = 0; i < validTexts.length; i++) {
      const originalIndex = validIndices[i];
      results[originalIndex] = extractEmbedding(batchResult, i);
    }
  } catch (err) {
    console.error("❌ Erreur lors de la génération d'embeddings batch:", err.message);
    // Tous les résultats restent null → fallback keyword
  }

  return results;
}

/**
 * Similarité cosinus entre deux vecteurs de même dimension.
 * Retourne un score entre 0 et 1 (1 = identique, 0 = orthogonal).
 */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Trouve les topK chunks les plus similaires à la requête
 * en comparant les embeddings.
 *
 * @param {number[]} queryEmbedding - Embedding de la requête
 * @param {Array<{chunk:string, embedding:number[]|null, title:string}>} chunkEntries
 * @param {number} topK - Nombre de résultats
 * @returns {Array<{score:number, chunk:string, title:string}>}
 */
export function findSimilarChunks(queryEmbedding, chunkEntries, topK = 4) {
  if (!queryEmbedding || !chunkEntries || chunkEntries.length === 0) return [];

  const scored = [];

  for (const entry of chunkEntries) {
    if (!entry.embedding) continue; // chunk sans embedding
    const score = cosineSimilarity(queryEmbedding, entry.embedding);
    if (score > 0) {
      scored.push({
        score,
        chunk: entry.chunk,
        title: entry.title,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/**
 * Libère le modèle d'embedding de la mémoire (utile pour le rechargement).
 */
export function resetEmbeddingModel() {
  embeddingPipeline = null;
  embeddingLoading = null;
  console.log("🧹 Modèle d'embedding libéré (sera rechargé au prochain besoin)");
}
