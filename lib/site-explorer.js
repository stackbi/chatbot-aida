/**
 * Exploration autonome du site web (mode « autonome »)
 *
 * Quand le contexte RAG est insuffisant pour répondre, le serveur explore
 * automatiquement le site web du client (celui où le widget est intégré) :
 *   1. Valide l'URL (protection SSRF : pas de localhost ni d'IP privée)
 *   2. Crawl BFS same-origin (nombre de pages et durée totale limités)
 *   3. Extrait le texte lisible des pages HTML (sans scripts, styles, nav…)
 *   4. Recherche les passages les plus pertinents pour la question posée
 *   5. Construit un bloc de contexte injecté dans le system prompt
 *
 * Résultats mis en cache par origine (TTL configurable) pour éviter de
 * recrawler le site à chaque message.
 */

import dns from "dns/promises";
import { retrieveRelevantChunksSync } from "./retrieval.js";
import { chunkText } from "./store.js";

// ── Limites de sécurité / performance ────────────────────────────────
const MAX_PAGES = 10;              // nombre max de pages crawlées par origine
const MAX_DEPTH = 3;               // profondeur max du crawl BFS
const PAGE_TIMEOUT_MS = 5000;      // timeout d'une requête HTTP
const CRAWL_DEADLINE_MS = 9000;    // durée totale max d'un crawl (toutes pages)
const CONCURRENCY = 3;             // fetchs simultanés max pendant le crawl
const PAGE_MAX_BYTES = 500 * 1024; // taille max d'une page (500 Ko)
const PAGE_MAX_TEXT = 6000;        // caractères de texte conservés par page
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 min avant recrawl
const CACHE_MAX_ENTRIES = 50;      // évite une croissance mémoire illimitée
const CRAWL_BUDGET_WINDOW_MS = 10 * 60 * 1000; // budget global d'exploration
const CRAWL_BUDGET_MAX = 30;       // max de nouveaux crawls par fenêtre
const ALLOW_LOCAL = process.env.ALLOW_LOCAL_SITE_CRAWL === "1";

// ── Cache par origine ─────────────────────────────────────────────────
const siteCache = new Map(); // origin -> { pages, fetchedAt }
const inflight = new Map();  // origin -> Promise (dédupe des crawls simultanés)
// Budget global : évite qu'un visiteur malveillant déclenche des centaines
// de crawls vers des origines différentes (abus de bande passante).
const crawlLog = []; // timestamps des crawls récents

function withinCrawlBudget() {
  const now = Date.now();
  // Purge les entrées plus vieilles que la fenêtre
  while (crawlLog.length > 0 && now - crawlLog[0] > CRAWL_BUDGET_WINDOW_MS) {
    crawlLog.shift();
  }
  if (crawlLog.length >= CRAWL_BUDGET_MAX) return false;
  crawlLog.push(now);
  return true;
}

/**
 * Vérifie qu'une URL est crawlable (http/https, hôte public).
 * Bloque les IP privées, loopback, link-local et localhost (protection SSRF),
 * sauf si ALLOW_LOCAL_SITE_CRAWL=1 (utile pour les tests locaux).
 */
/** Vérifie si une adresse IP (IPv4/IPv6) est privée, réservée ou locale. */
function isPrivateIp(ip) {
  if (!ip) return true;
  const clean = ip.replace(/^\[|\]$/g, "").toLowerCase();
  if (clean === "::1" || clean === "::" || clean === "0.0.0.0") return true;
  if (clean.includes(":")) {
    // IPv6 : fc00::/7 (ULA), fe80::/10 (link-local), ::ffff: pour IPv4 mappée
    if (clean.startsWith("fc") || clean.startsWith("fd") || clean.startsWith("fe8") || clean.startsWith("fe9")) return true;
    const m = clean.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateIp(m[1]);
    return false;
  }
  if (/^127\./.test(clean)) return true;
  if (/^10\./.test(clean)) return true;
  if (/^192\.168\./.test(clean)) return true;
  if (/^169\.254\./.test(clean)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(clean)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(clean)) return true; // CGNAT
  return false;
}

/**
 * Vérifie qu'un nom d'hôte ne résout PAS vers une adresse privée/locale
 * (protection contre le DNS rebinding : un domaine public → IP interne).
 * Les résultats DNS ne sont pas mis en cache ici : le cache des pages
 * (TTL 15 min) amortit déjà le coût d'un lookup par origine.
 */
async function hostIsPublic(hostname) {
  try {
    const { address } = await dns.lookup(hostname);
    return !isPrivateIp(address);
  } catch {
    return false; // résolution impossible → on ne crawle pas
  }
}

/**
 * Vérifie qu'une URL est crawlable (http/https, hôte public, résolution DNS
 * publique). Bloque les IP privées, loopback, link-local et localhost
 * (protection SSRF), sauf si ALLOW_LOCAL_SITE_CRAWL=1 (tests locaux).
 *
 * Note : cette fonction est synchrone et ne fait PAS de lookup DNS (ce rôle
 * revient à hostIsPublic, appelé une fois par origine avant le crawl).
 */
export function isSafeSiteUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  if (ALLOW_LOCAL) return true;

  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1" || host === "0.0.0.0") return false;
  if (/^127\./.test(host)) return false;
  if (/^10\./.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false; // lien local (metadata cloud…)
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return false; // CGNAT
  if (host.endsWith(".local") || host.endsWith(".localhost")) return false;
  // IP littérales déjà testées ci-dessus ; un nom de domaine doit résoudre
  // vers une IP publique — vérifié par hostIsPublic avant le crawl.
  return true;
}

/**
 * Extrait le texte lisible d'une page HTML : supprime scripts, styles, nav,
 * footer, header, aside, form, etc., puis normalise les espaces.
 */
function htmlToText(html) {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(nav|footer|header|aside|form|button|select|input|textarea)[\s\S]*?<\/\1>/gi, " ");

  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|ul|ol)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
}

/** Extrait le <title> d'une page HTML. */
function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/<[^>]+>/g, "").trim().slice(0, 120) : "";
}

/**
 * Extrait les liens internes (même origine) d'une page HTML.
 * Retourne des URLs absolues normalisées (sans fragment).
 */
function extractInternalLinks(html, baseUrl, origin) {
  const links = [];
  const hrefRe = /href\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = hrefRe.exec(html)) !== null && links.length < 60) {
    const raw = match[1];
    if (!raw || raw.startsWith("#") || raw.startsWith("mailto:") || raw.startsWith("tel:")) continue;
    try {
      const abs = new URL(raw, baseUrl);
      if (abs.origin !== origin) continue;          // même origine uniquement
      if (!/^https?:$/.test(abs.protocol)) continue;
      abs.hash = "";                                 // ignore les ancres
      const href = abs.href;
      // Ignore les fichiers binaires / ressources
      if (/\.(pdf|jpg|jpeg|png|gif|webp|svg|ico|css|js|zip|rar|mp3|mp4|woff2?|ttf|eot|docx?|xlsx?|pptx?)(\?|#|$)/i.test(href)) continue;
      if (!links.includes(href)) links.push(href);
    } catch { /* URL invalide → ignorée */ }
  }
  return links;
}

/**
 * Télécharge une page HTML avec timeout et limite de taille.
 * Revalide l'URL finale après redirections (anti-SSRF par redirect).
 * Retourne le HTML brut ou null.
 */
async function fetchPageHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "AidaChatbot/1.0 (assistant de site; contact@aida.local)",
        "Accept": "text/html,application/xhtml+xml"
      }
    });
    // Anti-SSRF : vérifie que l'URL finale (après redirections) reste sûre
    if (!isSafeSiteUrl(res.url)) return null;
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) return null;
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > PAGE_MAX_BYTES) return null;
    return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  } catch {
    return null; // timeout ou erreur réseau → page ignorée
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Crawl BFS same-origin avec fetchs parallèles bornés et deadline globale.
 * Retourne un tableau de { url, title, text }.
 */
async function crawlSite(startUrl) {
  const origin = new URL(startUrl).origin;
  const deadline = Date.now() + CRAWL_DEADLINE_MS;
  const pages = [];
  const visited = new Set();
  const queue = [{ url: origin + "/", depth: 0 }];

  const stop = () => pages.length >= MAX_PAGES || Date.now() > deadline;

  while (queue.length > 0 && !stop()) {
    // Pré-lève jusqu'à CONCURRENCY URLs simultanément
    const batch = [];
    while (queue.length > 0 && batch.length < CONCURRENCY && !stop()) {
      batch.push(queue.shift());
    }
    const results = await Promise.all(
      batch.map(async ({ url, depth }) => {
        if (visited.has(url) || depth > MAX_DEPTH) return null;
        visited.add(url);
        const html = await fetchPageHtml(url);
        if (!html) return null;
        const text = htmlToText(html);
        if (text.length < 60) return null;
        const links = depth < MAX_DEPTH ? extractInternalLinks(html, url, origin) : [];
        return {
          depth,
          page: { url, title: extractTitle(html) || url, text: text.slice(0, PAGE_MAX_TEXT) },
          links
        };
      })
    );

    for (const r of results) {
      if (!r) continue;
      pages.push(r.page);
      if (stop()) break;
      for (const link of r.links) {
        if (!visited.has(link) && !queue.some((q) => q.url === link)) {
          queue.push({ url: link, depth: r.depth + 1 });
        }
      }
    }
  }

  return pages;
}

/**
 * Retourne les pages crawlées pour une origine (avec cache + dédupe).
 */
export async function getCrawledPages(siteUrl) {
  if (!isSafeSiteUrl(siteUrl)) return null;
  const origin = new URL(siteUrl).origin;
  const cached = siteCache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.pages;
  }
  // Dédupe : un seul crawl simultané par origine
  if (inflight.has(origin)) return inflight.get(origin);
  // Budget global : limite le nombre de nouveaux crawls sur la fenêtre
  if (!withinCrawlBudget()) return null;
  // Anti-DNS-rebinding : l'hôte doit résoudre vers une IP publique
  if (!ALLOW_LOCAL && !(await hostIsPublic(new URL(origin).hostname))) return null;

  const promise = crawlSite(origin)
    .then((pages) => {
      siteCache.set(origin, { pages, fetchedAt: Date.now() });
      // Éviction simple : supprime l'entrée la plus ancienne si le cache grossit trop
      if (siteCache.size > CACHE_MAX_ENTRIES) {
        const oldestKey = siteCache.keys().next().value;
        siteCache.delete(oldestKey);
      }
      return pages;
    })
    .finally(() => inflight.delete(origin));

  inflight.set(origin, promise);
  return promise;
}

/**
 * Recherche dans les pages crawlées les passages pertinents pour la question.
 * Réutilise la recherche par mots-clés du module retrieval.
 *
 * @returns {Promise<Array<{score:number, chunk:string, title:string}>>}
 */
export async function searchSiteContent(siteUrl, query, topK = 4) {
  const pages = await getCrawledPages(siteUrl);
  if (!pages || pages.length === 0) return [];

  // Transforme chaque page en pseudo-document découpé en chunks (réutilise chunkText)
  const docs = pages.map((page) => ({
    title: page.title || page.url,
    chunks: chunkText(page.text)
  }));

  return retrieveRelevantChunksSync(docs, query, topK);
}

/**
 * Construit le bloc de contexte à injecter dans le system prompt
 * à partir des passages trouvés sur le site.
 */
export function buildSiteContextBlock(matches) {
  if (!matches || matches.length === 0) return "";
  const parts = matches.map(
    (m, i) => `[Info site ${i + 1}]\n${m.chunk}`
  );
  return (
    "\n\n« INFORMATIONS DU SITE WEB : ces informations ont été consultées automatiquement " +
    "sur notre site. Utilise-les pour répondre précisément. Ne mentionne JAMAIS le mot « site », " +
    "« page » ou « lien » : réponds comme si tu connaissais déjà ces informations en interne. »\n\n" +
    parts.join("\n\n")
  );
}
