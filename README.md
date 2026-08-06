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
   fort, différent de celui de `.env.example`).4. **Monte un volume persistant sur le dossier `data/`** — sinon la config (dont
   la **clé API**) et la base de connaissances seront effacées à chaque redéploiement
   ou redémarrage. La plupart des plateformes proposent cette option ("persistent
   volume" / "disk"). Pas de volume possible ? Deux alternatives :
   - définis `DATA_DIR` sur la plateforme pour pointer vers un chemin persistant ;
   - ou définis tes clés via les variables d'environnement `OPENROUTER_API_KEY`,
     `GROQ_API_KEY`, `OPENAI_API_KEY`, `CUSTOM_API_KEY` (elles persistent par nature).

   > 🔍 **Détection automatique** : à chaque démarrage, le serveur vérifie si le
   > dossier `data/` a survécu au redémarrage précédent. Si non (stockage éphémère),
   > un avertissement s'affiche dans les logs ET dans le tableau de bord admin.
   > La bannière de l'admin est **adaptée au cas réel** : stockage confirmé (aucune
   > bannière), premier démarrage (info, rien n'a encore été perdu), clés fournies
   > par variables d'environnement (info verte : elles survivent), ou stockage
   > éphémère avec données (alerte). Sur Render free, les données du plan gratuit
   > ne survivent pas aux redéploiements — voir la section dédiée ci-dessous.

   → Les instructions précises (Docker Compose, Railway, Render) sont dans la
   section **Déployer en production — persistance garantie** ci-dessous.
5. Note l'URL publique que la plateforme te donne, par exemple `https://mon-chatbot.up.railway.app`.

---

## Déployer en production — persistance garantie (Docker / Railway / Render)

Le dépôt inclut désormais les fichiers de déploiement prêts à l'emploi :
`Dockerfile`, `docker-compose.yml`, `.dockerignore` et `render.yaml`.

> 🧭 **Comment vérifier que la persistance fonctionne** : après le 2ᵉ démarrage,
> le serveur affiche dans les logs `✅ Stockage persistant confirmé` (ou `⚠️` si le
> dossier est éphémère). La clé API et les documents vivent dans `DATA_DIR`
> (défaut `./data`) ; il suffit de pointer cette variable vers un volume.

### Option A — Docker Compose (auto-hébergement)

```bash
cp .env.example .env        # définis ADMIN_PASSWORD (obligatoire)
docker compose up -d --build
```

- Le volume nommé **`aida-data`** est monté sur `/app/data` (= `DATA_DIR`) :
  `store.json` (clé API, paramètres) et les documents y survivent aux
  redémarrages, recréations de conteneur et mises à jour d'image.
- `docker compose down` **conserve** le volume ; `docker compose down -v` le
  **supprime** (données perdues — à n'utiliser qu'en test).
- Le modèle d'embedding (~170 Mo) est pré-chargé **dans l'image** au build :
  premier démarrage instantané, aucun téléchargement au premier message.
- Vérification : `docker compose ps` → état `healthy`, puis `docker compose
  logs` → `✅ Stockage persistant confirmé` après un redémarrage.

### Option B — Railway

1. Déploie le dépôt (Web service) et configure les variables :
   `ADMIN_PASSWORD` et `TRUST_PROXY=1`.
2. Dans l'onglet du service → **Volumes** → crée un volume avec le chemin de
   montage **`/app/data`** (le volume est rattaché à l'environnement de
   déploiement).
3. Aucune autre configuration : le serveur utilise déjà `./data` comme défaut,
   ce qui correspond à `/app/data` dans l'image.

> ⚠️ Les volumes Railway sont disponibles à partir du plan **Hobby** (pas de
> volume sur le plan gratuit).

### Option C — Render

**Via Blueprint (recommandé)** : commit `render.yaml` (fourni) à la racine du
dépôt, puis sur render.com → **New → Blueprint** → choisis le dépôt. Le
blueprint déclare un disque persistant monté à `/opt/aida-data` et configure
`DATA_DIR` dessus automatiquement. Saisis `ADMIN_PASSWORD` à la création.

**Via le dashboard** (équivalent manuel) :
1. Déploie le dépôt (web service).
2. Configure les variables : `ADMIN_PASSWORD`, `TRUST_PROXY=1` et
   **`DATA_DIR=/opt/aida-data`**.
3. Service → **Disks** → *Add Disk* → chemin de montage ` /opt/aida-data`.

> ⚠️ Les disques Render sont disponibles à partir du plan **Starter** (pas de
> disque sur le plan gratuit).

#### Render plan gratuit — pourquoi la bannière « Stockage non persistant » s'affiche

Sur le plan gratuit de Render (et Railway), le système de fichiers du conteneur
est **éphémère** : tout ce qui est écrit dans `data/` (clé API, documents) est
effacé à chaque redéploiement, redémarrage ou mise en veille. Le serveur le
détecte via son marqueur de persistance et l'admin affiche alors la bannière —
c'est un **message réel, pas un bug** : sur ce plan, les données ne peuvent pas
survivre sans volume.

**Comment éviter de ressaisir les clés à chaque redéploiement ?**

1. **Définis les clés dans les variables d'environnement** Render (c'est la
   solution recommandée, gratuite et fiable) :
   `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `OPENAI_API_KEY`, `CUSTOM_API_KEY`.
   Elles survivent à tous les redémarrages et redéploiements **par nature**.
   → La bannière devient alors une simple info verte : « Clés sécurisées par
   variables d'environnement ».
2. Les **documents** (base de connaissances) ne survivent pas sur le plan
   gratuit : pour les conserver, passe sur un plan avec disque (Starter+) ou
   ré-importe-les après chaque déploiement.

### Cache du modèle d'embedding

- **Docker** : le modèle est dans l'image (pré-chargé au build) — rien à faire.
- **Railway / Render** : le cache du modèle vit dans
  `node_modules/@huggingface/transformers/.cache` (chemin fixe, non redirigeable
  par variable d'environnement dans transformers.js v4) et est **re-téléchargé à
  chaque redéploiement** (~170 Mo). Ce n'est pas bloquant : le serveur télécharge
  automatiquement au démarrage. Pour l'éviter, il est possible de monter un
  volume supplémentaire sur ce chemin (même principe que `aida-data`).

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

Le prompt par défaut est conçu pour mener une **discussion naturelle, pas à pas**,
tout en restant factuel et en évitant les réponses génériques :

| Principe | Objectif |
|---|---|
| **Engagement** | Salutations et prises de contact ("Bonjour"...) → réponse chaleureuse + une question ouverte. Jamais de pitch de solutions dès le premier message |
| **Pas à pas** | Besoin vague → une question de clarification. Plusieurs étapes → présentées une par une, en laissant le visiteur choisir |
| **Concret** | Chaque réponse repose sur le contexte fourni (documents RAG) avec des chiffres, noms et prix exacts |
| **Anti-générique** | Interdit les phrases passe-partout ("nous proposons divers services", "n'hésitez pas à nous contacter") |
| **Vérification** | Auto-vérification avant chaque réponse (contexte, langue, voix) |

> 💡 Les messages purement conversationnels ("Bonjour", "Merci"...) ne déclenchent
> ni recherche RAG ni exploration du site : Aïda répond chaleureusement et engage
> la discussion. La recherche de contexte ne s'active que sur une vraie question.
>
> 🔀 **Changements de sujet** : le visiteur peut changer totalement de sujet en
> cours de route (ex. : du cloud au développement web). Le serveur détecte le
> changement de sujet (comparaison sémantique + signaux explicites comme
> "passons à autre chose"), réinitialise l'historique de la session et ordonne à
> l'IA de répondre à la nouvelle question sans référence aux échanges précédents,
> en s'appuyant sur le contexte le plus récent.

Le prompt est modifiable depuis l'admin → onglet **Paramètres** → **Instructions générales**.
Si le prompt par défaut d'origine est encore enregistré, il est remplacé automatiquement
par la nouvelle version au démarrage.

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
        data-accent-color="#e1ae07ff"             # couleur principale
        data-accent-color-dark="#93e140ff"        # couleur de survol
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
| `LANGTOOL_TIMEOUT` | Timeout de l'appel LanguageTool en millisecondes (court par défaut pour ne jamais retarder la réponse) | `1500` |
| `ALLOW_LOCAL_SITE_CRAWL` | Autorise l'exploration du site sur les adresses locales/privées (localhost, 127.0.0.1, 10.x…) — **uniquement pour les tests locaux**, jamais en production (risque SSRF) | désactivé |
| `DATA_DIR` | Dossier où sont stockés `store.json` (paramètres + clés API) et les documents. À pointer vers un **volume persistant** sur les plateformes au système de fichiers éphémère (Railway, Render…) | `./data` |
| `OPENROUTER_API_KEY` | Clé API OpenRouter **par variable d'environnement** : utilisée si aucune clé n'est enregistrée dans l'admin. Survit à tous les redémarrages, même sans volume persistant | — |
| `GROQ_API_KEY` | Clé API Groq par variable d'environnement (même rôle que ci-dessus) | — |
| `OPENAI_API_KEY` | Clé API OpenAI par variable d'environnement (même rôle que ci-dessus) | — |
| `CUSTOM_API_KEY` | Clé de l'API personnalisée par variable d'environnement (même rôle que ci-dessus) | — |
| `PUBLIC_URL` | URL publique du service (ex. `https://chatbot-aida.onrender.com`). Si définie, active l'**anti-veille intégré** : le serveur se ping lui-même sur `/api/keepalive` (réponse 204, ultra-légère) toutes les 5 min pour empêcher la mise en veille des plans gratuits (Render…). Vide = fallback sur `RENDER_EXTERNAL_URL` (auto sur Render) ; les deux vides = désactivé | — |
| `KEEP_AWAKE_INTERVAL_MS` | Intervalle du self-ping anti-veille en millisecondes | `300000` (5 min) |

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

> 🛠️ **Stabilité à l'arrêt du serveur** : le projet utilise
> `@huggingface/transformers` **v4** (`^4.2.0`), qui dépend nativement de
> `onnxruntime-node@1.24.3`. C'est important : les versions antérieures de la
> librairie native (1.21.x) contenaient un bug connu qui faisait **planter le
> processus à l'arrêt** (SIGTERM/SIGINT) avec
> `libc++abi: terminating … mutex lock failed: Invalid argument`. Le correctif est
> monté en amont dans transformers v4 — **plus aucun override n'est nécessaire**
> dans `package.json`. Ne rétrograde pas cette dépendance (en cas de passage à
> yarn/pnpm, l'équivalent pour forcer une version serait `resolutions` /
> `pnpm.overrides`).

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
| `/api/chat/suggestions` | POST | Suggestions de **suivi** générées selon la conversation en cours | 60 s par échange |
| `/api/chat/reset` | POST | Réinitialiser la conversation du visiteur (efface l'historique de sa session côté serveur) — utilisé par le bouton « Réinitialiser » du widget | Non |
| `/api/widget-config` | GET | Config du widget (nom, couleurs, police) — ETag | 60 s |
| `/api/widget-suggestions` | GET | Suggestions initiales basées sur la base de connaissances — ETag | 60 s |
| `/api/health` | GET | Health check (monitoring, load balancer) | Non |
| `/api/keepalive` | GET | Keep-alive anti-veille — réponse vide `204`, le plus léger possible (utilisé par le self-ping du serveur) | Non |

> 💡 **Suggestions dynamiques** : à l'ouverture, le widget affiche des questions
> issues de la base de connaissances. Après **chaque réponse**, elles sont
> régénérées par l'IA en fonction du dernier échange : la discussion rebondit
> naturellement (ex. après une question sur les prix → questions de suivi sur
> les garanties, le paiement, les délais…), au lieu de répéter le même catalogue.
> Ce comportement se désactive depuis `/admin` → **Paramètres** → **Suggestions de
> questions** (les suggestions initiales de la base restent alors seules affichées).
>
> 🔄 **Propagation rapide** : le widget recharge la config ET les suggestions
> toutes les ~60 s avec cache-busting (`?v=…`), et à chaque ouverture du chat.
> Un changement fait dans l'admin (nom, couleurs, toggle…) ou l'ajout d'un
> document dans la base de connaissances est donc visible en moins d'une minute,
> sans attendre l'expiration des anciens caches.
>
> 🛰️ **Indicateur de propagation** : près du bouton **Enregistrer**, le tableau
> de bord affiche un chip qui confirme que les widgets connectés ont bien reçu
> la nouvelle config („Config reçue par N widget(s)“) et combien sont actifs sur
> les 5 dernières minutes (`GET /api/admin/widget-status`).

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

## Garder le serveur éveillé — anti-veille intégré (Render plan gratuit)

Render (plan gratuit) met le service en veille après ~15 min **sans trafic
entrant**. Plutôt qu'un cron GitHub Actions ou un moniteur externe, Aïda
embarque un **self-ping intégré** : le serveur se ping **lui-même** sur son
URL publique (`/api/keepalive`) **toutes les 5 minutes**. La requête traverse
le reverse proxy de la plateforme, donc elle compte comme du **trafic entrant
réel** et empêche la mise en veille — sans aucune dépendance externe.

### Activation — automatique sur Render

**Aucune configuration nécessaire sur Render** : le `render.yaml` fourni fixe
`PUBLIC_URL=https://chatbot-aida.onrender.com` (la valeur par défaut du
service), et même si elle était vide, le serveur retomberait sur
`RENDER_EXTERNAL_URL`, que Render injecte automatiquement sur chaque web
service. L'anti-veille est donc **actif dès le premier déploiement via le
Blueprint**. Au démarrage, le serveur affiche :
`⏰ Anti-veille actif : self-ping …/api/keepalive toutes les 5 min`.

**Sur les autres plateformes** (Railway…) : définir manuellement la variable
`PUBLIC_URL` (l'URL publique du service). Localement, laisser `PUBLIC_URL`
vide désactive l'anti-veille (inutile de se pinger soi-même).

### Détails techniques

- Intervalle : **5 min** par défaut (`KEEP_AWAKE_INTERVAL_MS`, en ms). Bien
  sous le seuil de ~15 min de Render, avec une marge confortable.
- Cible : `/api/keepalive` — endpoint dédié, réponse **vide `204`**, sans
  aucun calcul ni logique métier (encore plus léger que `/api/health`, qui
  reste utilisé par les healthchecks d'infra).
- Robustesse : timeout de 15 s, échecs **silencieux** (un simple warning
  sporadique) — un ping raté ne fait jamais tomber le serveur, l'intervalle
  suivant réessaie. Un échec au démarrage est normal (instance en cours de
  montée) et n'affecte que le premier cycle.

> ⚠️ **Limite à connaître** : le plan gratuit Render inclut **750 h/mois** —
> garder le service éveillé 24/7 consomme ~720 h/mois, il peut donc se mettre
> en veille les derniers jours du mois. C'est le compromis du plan gratuit.
> Le self-ping ne change rien à ce budget d'heures ; il évite simplement la
> mise en veille due à l'inactivité.
>
> 💡 **Hypothèse à vérifier** : l'anti-veille repose sur le fait que la
> plateforme compte le trafic venant du service lui-même comme du trafic
> entrant (c'est le cas sur Render et Railway, consensus communautaire).
> Si un warning `Anti-veille : ping échoué` apparaît dans les logs, ou si le
> service se met quand même en veille, complète avec un moniteur externe
> gratuit (ex. UptimeRobot, ping toutes les 5 min).

---

## Licence

MIT
