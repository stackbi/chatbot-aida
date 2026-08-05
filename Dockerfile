# ─── Aïda Chatbot — image de production ──────────────────────────────────
# Build :  docker build -t aida-chatbot .
# Run   :  docker run -p 3000:3000 -v aida-data:/app/data -e ADMIN_PASSWORD=... aida-chatbot
# (ou plus simplement : docker compose up -d --build, voir docker-compose.yml)

FROM node:22-bookworm-slim

# Dépendances d'abord (cache de couche efficace : ne re-installe pas
# node_modules à chaque modification du code)
WORKDIR /app
COPY package.json package-lock.json ./
# npm ci (et non install) : reproduction exacte depuis le lockfile.
# onnxruntime-node et sharp disposent de binaires précompilés → pas besoin
# de chaîne de compilation (python/gcc) sur linux amd64/arm64.
RUN npm ci --no-audit --no-fund

# Code source (le dossier data/ du dépôt est exclu via .dockerignore ;
# les données vivent sur le volume monté à l'exécution)
COPY . .

# Dossier de données + permissions : le conteneur tourne en non-root (node).
# Le volume nommé monté sur /app/data héritera de ces permissions.
RUN mkdir -p /app/data

# Pré-télécharge le modèle d'embedding (~170 Mo) à la construction : démarrage
# à froid immédiat (pas de téléchargement à chaque premier message). Non
# bloquant : sans réseau au build, le modèle sera téléchargé au 1er démarrage.
# NB : ceci alourdit l'image (~2,4 Go au total). Alternative « image légère » :
# supprimer cette étape et monter un volume sur
# node_modules/@huggingface/transformers/.cache (modèle téléchargé au 1er run).
RUN node -e "import('@huggingface/transformers').then(async m => { await m.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2'); console.log('modele d embedding pre-charge dans l image'); })" \
    || echo "AVERTISSEMENT: modele non pre-charge au build (sera telecharge au premier demarrage)"

# Rend l'ensemble (dont le cache du modèle) accessible à l'utilisateur node
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
EXPOSE 3000

# Healthcheck natif Node (sans curl) : l'application est saine si /api/health répond
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
