/**
 * Correcteur orthographique et grammatical pour le français.
 * Utilise l'API LanguageTool (gratuite) pour détecter et corriger
 * les fautes d'orthographe, de grammaire, de conjugaison et de typographie.
 *
 * Usage :
 *   import { correctText } from "./lib/spellcheck.js";
 *   const corrected = await correctText("Nous somme la pour vous aidé.");
 *   // → "Nous sommes là pour vous aider."
 *
 * Variables d'environnement :
 *   SPELLCHECK_ENABLED=false    → désactive la correction (défaut: true)
 *   LANGTOOL_API_URL=...        → URL de l'API LanguageTool (défaut: https://api.languagetool.org/v2)
 *   LANGTOOL_TIMEOUT=5000       → timeout en ms (défaut: 5000)
 */

const API_BASE = process.env.LANGTOOL_API_URL || "https://api.languagetool.org/v2";
// Timeout court par défaut (1500 ms) : le correcteur est un bonus de qualité,
// jamais un frein à la réponse. S'il est trop lent, le fusible l'écarte et le
// texte part non corrigé (mieux qu'une réponse retardée).
const API_TIMEOUT = parseInt(process.env.LANGTOOL_TIMEOUT || "1500", 10);
const ENABLED = process.env.SPELLCHECK_ENABLED !== "false";
const MAX_CORRECT_LENGTH = 10000; // au-delà, on saute la correction (API lente/inutile)

// ── Fusible (circuit breaker) ──────────────────────────────────────────
// L'API LanguageTool est gratuite et externe : si elle échoue plusieurs fois
// de suite, on la désactive temporairement pour ne pas ajouter de latence à
// CHAQUE réponse du chatbot. Réarmée automatiquement après la pause.
let consecutiveFailures = 0;
let disabledUntil = 0;
const DISABLE_AFTER_FAILURES = 2;
const DISABLE_DURATION_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Applique les corrections LanguageTool à un texte.
 * Retourne le texte corrigé, ou le texte original si l'API est indisponible
 * ou si une erreur survient.
 *
 * @param {string} text - Texte français à corriger
 * @returns {Promise<string>} Texte corrigé
 */
export async function correctText(text) {
  if (!ENABLED) return text;
  if (!text || text.length < 10 || text.length > MAX_CORRECT_LENGTH) return text;
  if (Date.now() < disabledUntil) return text; // fusible ouvert → pas de latence

  try {
    const matches = await fetchMatches(text);
    // L'API a répondu correctement (même sans match) : c'est un succès,
    // le compteur d'échecs est réarmé. Seuls les vrais échecs réseau/API
    // (exception) doivent alimenter le fusible.
    consecutiveFailures = 0;
    if (!matches || matches.length === 0) return text;

    return applyCorrections(text, matches);
  } catch (err) {
    consecutiveFailures++;
    if (consecutiveFailures >= DISABLE_AFTER_FAILURES) {
      disabledUntil = Date.now() + DISABLE_DURATION_MS;
      consecutiveFailures = 0;
      console.warn(`⚠️ Correcteur orthographique désactivé ${DISABLE_DURATION_MS / 60000} min après ${DISABLE_AFTER_FAILURES} échecs consécutifs.`);
    } else {
      console.warn("⚠️ Correcteur orthographique indisponible, texte non modifié:", err.message);
    }
    return text;
  }
}

/**
 * Appelle l'API LanguageTool pour obtenir les erreurs détectées.
 *
 * @param {string} text
 * @returns {Promise<Array>} Tableau de matches LanguageTool
 */
async function fetchMatches(text) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT);

  try {
    const response = await fetch(`${API_BASE}/check`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json"
      },
      body: new URLSearchParams({
        text: text,
        language: "fr"
      })
    });

    if (!response.ok) {
      throw new Error(`LanguageTool HTTP ${response.status}`);
    }

    const data = await response.json();
    return data.matches || [];
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Applique les corrections en parcourant les matches de la fin vers le début
 * pour préserver les offsets après chaque remplacement.
 *
 * @param {string} text - Texte original
 * @param {Array} matches - Matches LanguageTool (déjà triés par offset croissant)
 * @returns {string} Texte corrigé
 */
function applyCorrections(text, matches) {
  // Filtrer les matches qui n'ont pas de remplacement utile
  const valid = matches.filter((m) => m.replacements && m.replacements.length > 0);

  // Trier par offset décroissant (de la fin vers le début)
  const sorted = [...valid].sort((a, b) => b.offset - a.offset);

  let result = text;
  const applied = new Set(); // Évite les corrections multiples au même endroit

  for (const match of sorted) {
    const key = `${match.offset}-${match.length}`;
    if (applied.has(key)) continue;
    applied.add(key);

    const suggestion = match.replacements[0].value;
    if (!suggestion || suggestion === result.slice(match.offset, match.offset + match.length)) {
      continue; // Suggestion identique → on ignore
    }

    result =
      result.slice(0, match.offset) +
      suggestion +
      result.slice(match.offset + match.length);
  }

  return result;
}
