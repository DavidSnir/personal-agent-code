# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json tsconfig.json ./
COPY services/cli-api/package.json services/cli-api/package-lock.json services/cli-api/tsconfig.json ./services/cli-api/

RUN --mount=type=cache,target=/root/.npm npm ci --prefix services/cli-api \
  --fetch-retries=5 \
  --fetch-retry-mintimeout=20000 \
  --fetch-retry-maxtimeout=120000 \
  --fetch-timeout=300000 \
  --no-audit \
  --fund=false
RUN ln -s services/cli-api/node_modules node_modules

COPY services/agent ./services/agent
COPY services/calendar ./services/calendar
COPY services/cli-api ./services/cli-api
COPY services/whatsapp/src/whatsapp ./services/whatsapp/src/whatsapp
COPY shared ./shared

RUN npm run build --prefix services/cli-api
RUN npm prune --omit=dev --prefix services/cli-api \
  --no-audit \
  --fund=false

FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/services/cli-api/package.json /app/services/cli-api/package-lock.json ./
COPY --from=build /app/services/cli-api/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN mkdir -p /runtime

# The CLI API can optionally restart the sibling agent container after it
# installs MCP config. In the standard compose deployment it talks to the
# mounted Docker socket for that restart, and the socket's host group id is not
# stable across Docker Desktop/Linux installs. Run this small control-plane
# container as root so the safe restart helper can access the mounted socket.

ENV DAGENT_RUNTIME_DIRECTORY=/runtime
CMD ["node", "dist/services/cli-api/src/index.js"]
