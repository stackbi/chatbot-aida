# Aïda — Chatbot IA widget embarquable + tableau de bord

Ce n'est **pas** un widget qui tourne en local sur ton site : c'est un service que tu déploies
une seule fois (comme Crisp ou Intercom), qui expose :

1. un **script à coller** sur ton vrai site (`<script src="https://ton-backend.com/widget.js">`),
   peu importe où ce site est hébergé ;
2. un **tableau de bord admin en ligne** (`https://ton-backend.com/admin`) pour tout gérer :
   clés API, personnalité du bot, et base de connaissances (RAG).

---

## Comment ça s'articule

```
Ton site web (n'importe où)          Ce backend (déployé une fois, ex: Railway/Render)
┌──────────────────────┐             ┌───────────────────────────────────┐
│ <script src=          │  appelle   │ /widget.js        → le widget      │
│  ".../widget.js">      │ ────────► │ /api/chat         → répond (RAG)   │
│                        │            │ /api/widget-config→ nom, message  │
└──────────────────────┘             │ /admin            → ton dashboard  │
                                       └───────────────────────────────────┘
```

Le script détecte lui-même l'adresse de ce backend (via sa propre URL), donc il n'y a
**aucune configuration à faire dans le code de ton site** : juste coller le tag `<script>`.

---

## Structure du projet

```
chatbot-rag/
├── server.js              → serveur Express (routes /api/chat, /api/admin/*, CORS)
├── lib/
│   ├── store.js           → persistance des paramètres et documents (fichier JSON)
│   ├── retrieval.js       → recherche du contexte pertinent (RAG)
│   ├── embedding.js       → embeddings vectoriels locaux (@huggingface/transformers)
│   ├── spellcheck.js      → correcteur orthographique (LanguageTool, avec fusible)
│   └── site-explorer.js   → exploration autonome du site web (mode autonome)
├── public/
│   ├── widget.js           → LE SCRIPT à coller sur ton vrai site
│   └── index.html         → page de test qui simule l'intégration réelle
├── admin/
│   └── index.html         → tableau de bord d'administration
├── data/store.json        → généré automatiquement au premier lancement
├── package.json
└── .env.example
```

---

## Étape 1 — Déployer ce backend en ligne

Ce projet est un serveur Node classique. Choisis un hébergeur qui garde le serveur actif
en permanence (contrairement aux fonctions serverless classiques, il faut ici un process
qui tourne — pense à Railway, Render, ou Fly.io) :

1. Pousse ce dossier sur un dépôt Git (GitHub, GitLab...).
2. Connecte ce dépôt à Railway / Render / Fly.io.
3. Configure la variable d'environnement `ADMIN_PASSWORD` sur la plateforme (mot de passe
   fort, différent de celui de `.env.example`).
4. **Monte un volume persistant sur le dossier `data/`** — sinon la config et la base de
   connaissances seront effacées à chaque redéploiement. La plupart des plateformes
   proposent cette option ("persistent volume" / "disk").
5. Note l'URL publique que la plateforme te donne, par exemple `https://mon-chatbot.up.railway.app`.

---

## Étape 2 — Configurer les fournisseurs IA

Le chatbot supporte **4 providers** avec une chaîne de fallback automatique :

### Chaîne de fallback

```
1. OpenRouter     → modèle principal (configuré dans l'admin)
2. Groq           → fallback gratuit (si clé configurée)
3. API locale     → fallback personnalisé (Ollama, vLLM...)
4. OpenAI         → fallback ultime payant (gpt-4o-mini)
```

Si un provider est saturé (429), le suivant prend le relais automatiquement avec un
backoff exponentiel (max 2s d'attente).

### OpenRouter (recommandé — modèle principal)

- Crée un compte sur [openrouter.ai](https://openrouter.ai)
- Génère une clé API sur [openrouter.ai/keys](https://openrouter.ai/keys)
- Colle la clé dans l'admin (onglet **Paramètres** → **Clé API OpenRouter**)
- Choisis un modèle parmi ceux proposés (Gemma 4 31B, Nemotron 3 Super 120B, GPT-OSS 20B...), tous vérifiés comme valides et gratuits via l'API OpenRouter

### Groq (fallback gratuit — recommandé)

- Crée un compte sur [console.groq.com](https://console.groq.com)
- Génère une clé API gratuite (14 400 req/jour)
- Colle la clé dans l'admin → **Clé API Groq**
- Chaîne de modèles utilisée : `openai/gpt-oss-120b` → `llama-3.3-70b-versatile` → `openai/gpt-oss-20b` (fallback automatique si un modèle est indisponible)

### API personnalisée (fallback local)

- Pour Ollama, vLLM, LocalAI, ou tout serveur OpenAI-compatible
- Configure l'URL (ex: `http://localhost:11434/v1`) et le nom du modèle
- Pas de clé API nécessaire si le serveur est local

### OpenAI (fallback ultime payant)

- Crée un compte sur [platform.openai.com](https://platform.openai.com)
- Génère une clé API (sk-proj-...)
- Colle la clé dans l'admin → **Clé API OpenAI**
- Modèle utilisé : `gpt-4o-mini`

### Notes importantes

> ⚠️ **Un seul provider suffit** pour faire fonctionner le chatbot. Les providers
> supplémentaires sont des **fallbacks** : ils sont utilisés uniquement si le provider
> principal est saturé ou indisponible.
>
> 💡 **Groq est recommandé en fallback** car son free tier est très généreux
> (14 400 requêtes/jour) et ses modèles sont rapides.
>
> ❌ **SiliconFlow a été retiré** des providers disponibles car son API renvoyait des
> annotations de sécurité (`"User Safety: safe"`) dans le contenu des réponses, ce qui
> altérait la qualité du chatbot.

### Tester la connexion

Une fois les clés configurées, clique sur **🔌 Tester la connexion** dans l'admin.
Le test parcourt toute la chaîne de fallback et indique quel provider répond.

---

## Étape 3 — Configurer la personnalité du bot

Dans l'onglet **Paramètres**, tu peux personnaliser :

| Champ | Description |
|---|---|
| **Nom de l'assistant** | Le nom affiché dans le widget |
| **Message d'accueil** | Le premier message que voit le visiteur |
| **Instructions (system prompt)** | Le comportement et le ton de l'IA |

### Le system prompt par défaut

Le prompt par défaut est conçu pour éviter les réponses génériques. Il suit 5 règles :

| Règle | Objectif |
|---|---|
| **#1** | Interdit les phrases passe-partout ("nous proposons divers services", "n'hésitez pas à nous contacter") |
| **#2** | Chaque réponse doit reposer sur le contexte fourni (documents RAG) |
| **#3** | Exige des informations spécifiques (chiffres, noms, prix) plutôt que du vague |
| **#4** | Auto-vérification avant chaque réponse |
| **#5** | Chaque réponse doit citer au moins une source du contexte |

Le prompt est modifiable depuis l'admin → onglet **Paramètres** → **Instructions générales**.

---

## Étape 4 — Installer le widget sur ton vrai site

Colle ce tag juste avant `</body>` sur les pages de ton site où tu veux le chatbot
(remplace l'URL par celle de ton backend déployé) :

```html
<script src="https://mon-chatbot.up.railway.app/widget.js" defer></script>
```

C'est tout — aucune autre étape. Le widget va automatiquement :
- afficher la bulle de chat flottante ;
- charger le nom du bot et le message d'accueil configurés dans l'admin ;
- envoyer chaque question au backend, qui va chercher le contexte
  pertinent (RAG) et interroger le modèle d'IA choisi.

### Options facultatives

```html
<script src="https://mon-chatbot.../widget.js"
        data-position="left"                    # position : "left" ou "right" (défaut)
        data-accent-color="#6c63ff"             # couleur principale
        data-accent-color-dark="#4a42cc"        # couleur de survol
        defer></script>
```

---

## Tester en local avant de déployer

```bash
npm install
cp .env.example .env    # choisis un mot de passe admin
npm start
```

- Page de test (simule ton vrai site) : http://localhost:3000
- Tableau de bord : http://localhost:3000/admin

---

## Variables d'environnement

Toutes les variables sont optionnelles **sauf `ADMIN_PASSWORD`**. Elles se
configurent dans `.env` en local ou dans les paramètres de la plateforme
(Railway / Render / Fly.io) en production.

| Variable | Rôle | Valeur par défaut |
|---|---|---|
| `ADMIN_PASSWORD` | 🔴 **Obligatoire** — mot de passe du tableau de bord `/admin`. Comparé de façon **timing-safe** (anti attaque par mesure de temps) | — |
| `PORT` | Port HTTP du serveur | `3000` |
| `TRUST_PROXY` | **Reverse proxy** (Railway, Render, Nginx…) : active `trust proxy` pour que le rate limiting et `req.ip` utilisent la vraie IP du visiteur au lieu de celle du proxy. **À activer uniquement si tu es derrière un proxy de confiance.** Valeurs acceptées : `1` (un saut de proxy), `2`, ou l'adresse du proxy ; `false`/`0`/`off` désactivent explicitement | désactivé |
| `CORS_ORIGINS` | Restreint les domaines autorisés à appeler les routes publiques (séparateur virgule). Ex. : `https://monsite.com,https://client2.com`. Laissé vide = n'importe quelle origine (nécessaire pour un widget multi-sites) | `*` (tout autorisé) |
| `SITE_URL` | Identification de l'application côté OpenRouter (`HTTP-Referer`) | — |
| `SPELLCHECK_ENABLED` | Désactive le correcteur orthographique externe (LanguageTool). Utile si l'API tierce est indisponible ou si tu veux zéro latence. Valeurs : `false` (désactive), tout autre = actif | activé |
| `LANGTOOL_API_URL` | URL de l'API LanguageTool (peut pointer vers une instance auto-hébergée) | `https://api.languagetool.org/v2` |
| `LANGTOOL_TIMEOUT` | Timeout de l'appel LanguageTool en millisecondes | `3000` |
| `ALLOW_LOCAL_SITE_CRAWL` | Autorise l'exploration du site sur les adresses locales/privées (localhost, 127.0.0.1, 10.x…) — **uniquement pour les tests locaux**, jamais en production (risque SSRF) | désactivé |

> 💡 **`TRUST_PROXY` et le rate limiting** : si tu déploies derrière un proxy (c'est le cas
> par défaut sur Railway et Render), sans cette variable **toutes les requêtes partagent la
> même IP** (celle du proxy) et le quota de 300 requêtes/15 min s'épuise très vite.
> Ajoute simplement `TRUST_PROXY=1` dans les variables de la plateforme.

---

## Base de connaissances (RAG)

Dans l'onglet **Base de connaissances**, tu peux :
- **Ajouter du texte** manuellement (FAQ, tarifs, conditions...)
- **Importer un PDF** (texte extrait automatiquement, 10 Mo max)
- **Supprimer** des documents existants

### Fonctionnement

Le RAG utilise 2 méthodes de recherche :

1. **Vectorielle** : embeddings générés automatiquement par un modèle local
   (`@huggingface/transformers`) pour trouver les passages les plus proches
   sémantiquement.
2. **Mots-clés** : fallback si les embeddings ne sont pas disponibles, ou si
   la recherche vectorielle ne trouve rien.

Les passages pertinents sont injectés dans le prompt de l'IA avant chaque réponse,
permettant au chatbot de répondre avec le contenu réel de ton site.

### 🌐 Mode autonome : exploration du site web

Quand le contexte RAG est **insuffisant** (aucun passage pertinent, ou score de
pertinence très faible), l'IA explore **automatiquement le site web** où le widget
est intégré pour y trouver la réponse :

- Le widget transmet automatiquement l'URL du site (`window.location.origin`) à
  chaque message — aucune configuration requise côté site.
- Le backend crawl le site (même domaine, profondeur et nombre de pages limités),
  extrait le texte lisible des pages et sélectionne les passages pertinents.
- Les pages sont mises en cache 15 minutes pour éviter de recrawler à chaque question.
- L'IA répond alors en s'appuyant sur le contenu réel du site, sans jamais le
  mentionner à l'utilisateur (elle parle comme si elle connaissait l'information).

**Configuration (optionnelle)** dans `/admin` → onglet **Paramètres** :

| Champ | Description |
|---|---|
| **Exploration du site** | Activer / désactiver le mode autonome (activé par défaut) |
| **URL du site à explorer** | Si vide, détection automatique du site d'intégration |

> 🔒 **Sécurité** : le backend refuse de crawler les adresses locales ou privées
> (localhost, 127.0.0.1, 10.x, 192.168.x, 169.254.x, etc.) pour éviter les
> attaques SSRF. Pour les tests en local uniquement, définis
> `ALLOW_LOCAL_SITE_CRAWL=1` dans les variables d'environnement.

---

## API — Routes publiques

| Route | Méthode | Description | Cache |
|---|---|---|---|
| `/api/chat` | POST | Envoyer un message (réponse complète) | Non |
| `/api/chat/stream` | POST | Envoyer un message (streaming SSE) | Non |
| `/api/widget-config` | GET | Config du widget (nom, couleurs, police) | 5 min |
| `/api/widget-suggestions` | GET | Suggestions de questions | 30 s |
| `/api/health` | GET | Health check | Non |

---

## Sécurité

- **CORS** : les routes publiques acceptent les requêtes depuis n'importe quel domaine
  (nécessaire pour un widget multi-sites). À restreindre avec `CORS_ORIGINS` si besoin.
- **Authentification admin** : mot de passe stocké dans la variable d'environnement
  `ADMIN_PASSWORD`, envoyé dans le header `x-admin-password`. Comparaison **timing-safe**
  (`crypto.timingSafeEqual`) pour éviter les attaques par mesure de temps.
- **Rate limiting** : 300 requêtes/15 min par IP sur `/api/chat`, 10 tentatives/15 min
  sur `/api/admin/login`. Derrière un reverse proxy, pense à `TRUST_PROXY=1` pour que
  le quota soit compté par visiteur réel et non par le proxy.
- **Anti-XSS widget** : les contenus dynamiques (message d'accueil, suggestions) sont
  échappés côté widget avant injection HTML.
- **Streaming robuste** : si un visiteur ferme le chat en cours de réponse, l'appel
  au fournisseur IA est **annulé immédiatement** (plus de tokens facturés inutilement) ;
  un fournisseur muet est interrompu après 45 s sans flux.
- **Clés API** : stockées en clair dans `data/store.json` côté serveur, jamais exposées
  au navigateur. Masquées dans l'admin (seuls les 6 derniers caractères sont visibles).
- **Spellcheck** : le correcteur externe (LanguageTool) est protégé par un **fusible**
  (circuit breaker) : après 2 échecs consécutifs, il est désactivé 5 min pour ne jamais
  ajouter de latence à chaque réponse.

---

## Toutes les commandes npm

```bash
npm start       # Démarre le serveur (port 3000 ou $PORT)
npm run dev     # Démarre avec Nodemon (redémarrage auto)
```

---

## Déploiement continu

Le projet inclut un workflow GitHub Actions (`daily-ping.yml`) qui ping l'URL
toutes les 24h pour éviter la mise en veille sur Render (plan gratuit).

---

## Licence

MIT
