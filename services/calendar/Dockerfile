# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json tsconfig.json ./
COPY services/calendar/package.json services/calendar/package-lock.json services/calendar/tsconfig.json ./services/calendar/

RUN --mount=type=cache,target=/root/.npm npm ci --prefix services/calendar \
  --fetch-retries=5 \
  --fetch-retry-mintimeout=20000 \
  --fetch-retry-maxtimeout=120000 \
  --fetch-timeout=300000 \
  --no-audit \
  --fund=false
RUN ln -s services/calendar/node_modules node_modules

COPY services/calendar ./services/calendar
COPY shared ./shared

RUN npm run build --prefix services/calendar
RUN node -e "import('./dist/shared/utils/runtimeDirectory.js').then((module) => { if (typeof module.getDefaultRuntimeDirectory !== 'function') throw new Error('dist/shared/utils/runtimeDirectory.js is missing getDefaultRuntimeDirectory'); })"
RUN npm prune --omit=dev --prefix services/calendar \
  --no-audit \
  --fund=false

FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/services/calendar/package.json /app/services/calendar/package-lock.json ./
COPY --from=build /app/services/calendar/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN mkdir -p /runtime && chown -R node:node /runtime /app
USER node

ENV DAGENT_RUNTIME_DIRECTORY=/runtime
CMD ["node", "dist/services/calendar/src/workerIndex.js"]
