# Build context: the repo root.  docker build -f apps/server/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /app
# Manifests first so the dependency layer caches until a package.json or the lockfile changes.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/engine/package.json packages/engine/
COPY packages/bots/package.json packages/bots/
COPY packages/protocol/package.json packages/protocol/
RUN npm ci -w apps/server --include-workspace-root=false
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/server apps/server
RUN npm run build -w apps/server

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/engine/package.json packages/engine/
COPY packages/bots/package.json packages/bots/
COPY packages/protocol/package.json packages/protocol/
# Production deps only; @felt/* are bundled into dist by tsup.
RUN npm ci -w apps/server --omit=dev --omit=optional --include-workspace-root=false && npm cache clean --force \
    && rm -rf node_modules/@felt && find node_modules -type d -empty -delete

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app/apps/server
COPY --from=deps --chown=node:node /app/node_modules /app/node_modules
COPY --from=build --chown=node:node /app/apps/server/dist ./dist
COPY --chown=node:node apps/server/package.json ./package.json
USER node
EXPOSE 3000
CMD ["node","dist/server.js"]
