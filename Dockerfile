FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Download the embedding model into the image. Fetching it on first use would
# make the first upload look stuck, and would put a network dependency in the
# request path of a service that otherwise needs none.
ENV TRANSFORMERS_CACHE=/app/.cache/huggingface
RUN node -e "import('@huggingface/transformers').then(async ({pipeline}) => { await pipeline('feature-extraction', process.env.EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2', {dtype:'fp32'}); console.log('model cached') })"

CMD ["node", "dist/server.js"]
