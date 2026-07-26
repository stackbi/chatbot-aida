# Chatbot IA — widget embarquable + tableau de bord en ligne

Ce n'est **pas** un widget qui tourne en local sur ton site : c'est un service que tu déploies
une seule fois (comme Crisp ou Intercom), qui expose :

1. un **script à coller** sur ton vrai site (`<script src="https://ton-backend.com/widget.js">`),
   peu importe où ce site est hébergé ;
2. un **tableau de bord admin en ligne** (`https://ton-backend.com/admin`) pour tout gérer :
   clé API, personnalité du bot, et base de connaissances (RAG).

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

## Structure du projet

```
chatbot-rag/
├── server.js              → serveur Express (routes /api/chat, /api/admin/*, CORS)
├── lib/
│   ├── store.js           → persistance des paramètres et documents (fichier JSON)
│   └── retrieval.js       → recherche du contexte pertinent (RAG)
├── public/
│   ├── widget.js           → LE SCRIPT à coller sur ton vrai site
│   └── index.html         → page de test qui simule l'intégration réelle
├── admin/
│   └── index.html         → tableau de bord d'administration
├── data/store.json        → généré automatiquement au premier lancement
├── package.json
└── .env.example
```

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

## Étape 2 — Configurer le bot depuis le tableau de bord

Rends-toi sur `https://mon-chatbot.up.railway.app/admin` :

1. Connecte-toi avec le mot de passe admin configuré à l'étape précédente.
2. Onglet **Paramètres** : colle ta clé API OpenRouter (récupérable sur
   https://openrouter.ai/keys), choisis le modèle, personnalise le nom du bot et le
   message d'accueil.
3. Onglet **Base de connaissances** : colle le contenu de tes pages (FAQ, horaires, tarifs,
   présentation de l'entreprise...). Chaque document est découpé en passages ; à chaque
   question d'un visiteur, le backend retrouve les passages pertinents et les injecte dans
   le prompt envoyé au modèle avant de générer la réponse.

## Étape 3 — Installer le widget sur ton vrai site

Colle ce tag juste avant `</body>` sur les pages de ton site où tu veux le chatbot
(remplace l'URL par celle de ton backend déployé) :

```html
<script src="https://mon-chatbot.up.railway.app/widget.js" defer></script>
```

C'est tout — aucune autre étape. Le widget va automatiquement :
- afficher la bulle de chat flottante ;
- charger le nom du bot et le message d'accueil configurés dans l'admin ;
- envoyer chaque question à `/api/chat` sur ton backend, qui va chercher le contexte
  pertinent (RAG) et interroger le modèle d'IA choisi.

Options facultatives sur le tag script :
```html
<script src="https://mon-chatbot.../widget.js"
        data-position="left"
        data-accent-color="#111827"
        data-accent-color-dark="#000000"
        defer></script>
```

## Tester en local avant de déployer

```bash
npm install
cp .env.example .env    # choisis un mot de passe admin
npm start
```
- Page de test (simule ton vrai site) : http://localhost:3000
- Tableau de bord : http://localhost:3000/admin

## Comment fonctionne le RAG dans cette version

Pas de base de données vectorielle ni de service d'embeddings externe : la recherche de
contexte (`lib/retrieval.js`) utilise une correspondance par mots-clés (fréquence de termes,
insensible aux accents et à la casse). C'est volontairement simple pour ne dépendre que de
ta clé API OpenRouter, et ça fonctionne bien pour une base de quelques dizaines de documents.

**Limite à connaître** : pas de compréhension sémantique fine (un synonyme absent du texte
source peut ne pas être retrouvé). Pour un site avec beaucoup de contenu ou un besoin de
recherche par sens plutôt que par mots-clés, il faudra migrer vers une vraie recherche
vectorielle (embeddings + base vectorielle comme Pinecone, Weaviate, ou pgvector).

## Sécurité — à renforcer avant une vraie mise en production

- **CORS** : les routes `/api/chat` et `/api/widget-config` acceptent les requêtes depuis
  n'importe quel domaine (nécessaire puisque ton site et ce backend sont sur des domaines
  différents). C'est normal pour un widget public, mais ça veut dire que n'importe qui
  connaissant l'URL de ton backend peut aussi appeler `/api/chat` — pense à surveiller
  l'usage et à ajouter un rate limiting (voir plus bas).
- **Authentification admin** : un mot de passe simple envoyé à chaque requête, stocké côté
  client dans `sessionStorage`. Suffisant pour démarrer, mais pour de la vraie production :
  HTTPS obligatoire (la plupart des hébergeurs le font par défaut), et idéalement un vrai
  système de comptes avec sessions/JWT à durée limitée.
- **Clé API** : stockée en clair dans `data/store.json` côté serveur (jamais exposée au
  navigateur). Ce fichier n'est pas servi publiquement, mais vérifie que ton hébergeur ne
  l'expose pas par un autre moyen (ex: dossier `data/` accessible via un autre service).
- **Rate limiting** : ajoute une limite de requêtes par IP/session sur `/api/chat` pour
  éviter les abus et maîtriser les coûts d'API (ex: package `express-rate-limit`).

## Pour aller plus loin

- Support **multi-sites** : si tu gères plusieurs sites, on peut ajouter un `siteId` par
  client (widget + config + base de connaissances séparées par site) plutôt qu'une seule
  configuration globale.
- **Streaming** des réponses (mot par mot) via Server-Sent Events.
- **Import automatique** du contenu d'une page via son URL, plutôt que le copier-coller
  manuel dans l'admin.
- **Statistiques d'usage** (nombre de conversations, questions fréquentes) dans le
  tableau de bord.
# chatbot-aida
