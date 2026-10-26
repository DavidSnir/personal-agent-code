# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY services/telegram/package.json services/telegram/package-lock.json ./
COPY tsconfig.json ./
COPY services/telegram/tsconfig.json ./services/telegram/tsconfig.json

RUN --mount=type=cache,target=/root/.npm npm ci \
  --fetch-retries=5 \
  --fetch-retry-mintimeout=20000 \
  --fetch-retry-maxtimeout=120000 \
  --fetch-timeout=300000 \
  --no-audit \
  --fund=false

COPY services/telegram ./services/telegram
COPY shared ./shared

RUN npx tsc -p services/telegram/tsconfig.json
RUN node -e "import('./dist/shared/utils/runtimeDirectory.js').then((module) => { if (typeof module.getDefaultRuntimeDirectory !== 'function') throw new Error('dist/shared/utils/runtimeDirectory.js is missing getDefaultRuntimeDirectory'); })"
RUN npm prune --omit=dev \
  --no-audit \
  --fund=false

FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN mkdir -p /runtime && chown -R node:node /runtime /app
USER node

ENV DAGENT_RUNTIME_DIRECTORY=/runtime
CMD ["node", "dist/services/telegram/src/telegramIndex.js"]
