# Forge production image. Build: docker compose build
FROM node:22-bookworm-slim

# Prisma's query engine needs OpenSSL
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# Install dependencies first so this layer is cached until package files change.
# The Prisma schema must be present because `postinstall` runs `prisma generate`.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

# Uploaded files live on a volume mounted here
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads
USER node

EXPOSE 3000
# Apply any new database migrations, then start the server
CMD ["sh", "-c", "npx prisma migrate deploy && node server/index.js"]
