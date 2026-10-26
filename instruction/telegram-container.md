# Telegram Container Instructions

## Scope

This file covers the implemented `telegram` container and its relationship to Compose `control-api`. The operator CLI is native, not a Compose service.

## Context

The Docker Telegram service is implemented by `services/telegram/src/telegramService.ts` and entered through `services/telegram/src/telegramIndex.ts`. The image `CMD` runs `node dist/services/telegram/src/telegramIndex.js`, not the full multi-service app entrypoint. The runner loads config with `forceTelegramEnabled: true`, creates only `TelegramConnectionService`, and wires it to the Telegram-owned `OpencodeTelegramAgent` adapter for HTTP calls to a separately running opencode server.

The Telegram package build is intentionally service-scoped with `services/telegram/tsconfig.json`. That file includes `src/telegramIndex.ts` plus `../../shared/**/*.ts` so shared runtime helpers used by Telegram credentials are compiled into `dist/shared/` for the container image. Do not fix missing shared helper exports by editing `dist/`; update TypeScript source or the service-scoped `tsconfig.json` include set and rebuild. `shared/utils/runtimeDirectory.ts` exports `getDefaultRuntimeDirectory()`, whose precedence is `DAGENT_RUNTIME_DIRECTORY`, persistent user config, then `process.cwd()` outside CLI flag parsing.

The Telegram Docker build stage must not copy the root `package.json` or depend on root runtime dependencies. It copies `services/telegram/package.json` and `services/telegram/package-lock.json` directly to `/app/package.json` and `/app/package-lock.json` so one package metadata location provides both dependency installation and ESM package scope. It runs `npm ci` and `npm prune --omit=dev` at `/app`, without `--prefix services/telegram` and without a `node_modules` symlink. It still copies the root `tsconfig.json` for compiler options and builds with `npx tsc -p services/telegram/tsconfig.json`. The Dockerfile source closure is only `services/telegram` plus `shared`; `services/telegram/Dockerfile.dockerignore` is an allowlist that sends only `tsconfig.json`, `shared/**`, and `services/telegram/**` to the build context while excluding dependencies, generated output, runtime state, secrets, VCS data, logs, and browser auth/cache folders. Preserve the Docker build-time assertion that dynamically imports `./dist/shared/utils/runtimeDirectory.js` and verifies `getDefaultRuntimeDirectory` is a function.

`services/telegram/src/telegram/opencodeTelegramAgent.ts` is the Telegram service's local opencode HTTP adapter. It owns the `AgentService` and `AgentModelOption` types consumed by `TelegramConnectionService`, uses Node built-in `fetch`, `Headers`, `URL`, and `Buffer`, and implements opencode health, session, provider/model listing, model selection, and message APIs. It filters response parts with `type === "reasoning"` before sending Markdown text back to Telegram. Do not reintroduce imports from `services/agent` into the Telegram service or Docker image unless the package boundary is intentionally redesigned.

The `telegram` compose service is a Telegram-only boundary. It must not construct or start opencode management, Calendar, WAHA, or control-api services. It connects to `agent` at `http://agent:4096` and waits for its healthcheck.

Initial container environment:

```env
DAGENT_RUNTIME_DIRECTORY=/runtime
OPENCODE_SERVER_URL=http://agent:4096
```

For a standalone run without the compose `agent` service, override `OPENCODE_SERVER_URL` to an externally reachable server such as `http://host.docker.internal:4096`.

Standard Compose keeps `DAGENT_RUNTIME_DIRECTORY=/runtime` but mounts only the Telegram service subtree: `${HOME}/.local/share/dagent/data/telegram:/runtime/data/telegram`. The narrow bind preserves isolation from unrelated runtime services while satisfying the unchanged credential contract `/runtime/data/telegram/credentials.json`. Telegram env credentials may come from the host-only optional env file `${HOME}/.local/share/dagent/data/telegram/.env`, which Compose injects into the process; they may also come from the mounted credentials file created by native `dagent --runtime-directory "${HOME}/.local/share/dagent" services auth telegram`.

Compose requires non-empty `HOME` and uses long binds with `create_host_path: false`. Initialize the canonical host sources before container creation. `OPENCODE_REQUEST_TIMEOUT_MS` may be supplied through the Telegram env file; it defaults to `120000`, is capped at `600000`, and bounds every call to `http://agent:4096`.

Do not expose the DAgent API from Telegram. API control belongs to Compose `control-api`, which runs `services/cli-api` source, sets `DAGENT_TELEGRAM_RUNTIME_DIRECTORY=/telegram-runtime`, mounts `${HOME}/.local/share/dagent/data/telegram:/telegram-runtime/data/telegram`, and maps `127.0.0.1:8000:8000` for host-native CLI requests.

## Docker Shape

Use the service Dockerfile at `services/telegram/Dockerfile` with the `telegram` compose target. The image:

- Uses Node.js 20 or newer.
- Copies `services/telegram/package.json` and `package-lock.json` to `/app/`.
- Copies the root `tsconfig.json` for shared compiler options.
- Relies on `services/telegram/Dockerfile.dockerignore` to keep the build context limited to root `tsconfig.json`, `shared/**`, and `services/telegram/**`.
- Runs `npm ci` at `/app` from the copied Telegram lockfile.
- Builds TypeScript with `npx tsc -p services/telegram/tsconfig.json`.
- Compile Telegram's entrypoint and required `shared/**/*.ts` helpers through `services/telegram/tsconfig.json`.
- Assert at build time that `dist/shared/utils/runtimeDirectory.js` exports `getDefaultRuntimeDirectory` as an ESM named export.
- Carry only production dependencies and compiled `dist/` into the runtime stage.
- Keep the runtime image free of Calendar, WAHA/control, and CLI API dependencies.
- Runs as the non-root `node` user in the runtime stage.
- Defaults to `node dist/services/telegram/src/telegramIndex.js`.

Initial compose service shape:

```yaml
services:
  telegram:
    build:
      context: .
      dockerfile: services/telegram/Dockerfile
    env_file:
      - path: ${HOME:?HOME must be set to use the canonical DAgent runtime}/.local/share/dagent/data/telegram/.env
        required: false
    environment:
      DAGENT_RUNTIME_DIRECTORY: /runtime
      OPENCODE_SERVER_URL: "http://agent:4096"
    volumes:
      - type: bind
        source: ${HOME:?HOME must be set to use the canonical DAgent runtime}/.local/share/dagent/data/telegram
        target: /runtime/data/telegram
        bind:
          create_host_path: false
    depends_on:
      agent:
        condition: service_healthy
    restart: unless-stopped
```

## Setup Flow

Build the container image:

```sh
docker compose build telegram
```

Initialize the mounted runtime directory without starting services:

```sh
dagent --runtime-directory "${HOME}/.local/share/dagent" services init compose
```

Create a real env file only in the ignored runtime folder when needed:

```sh
cp services/telegram/.env.example "${HOME}/.local/share/dagent/data/telegram/.env"
```

Store Telegram credentials without printing the token later:

```sh
dagent --runtime-directory "${HOME}/.local/share/dagent" services auth telegram --bot-token <token> --user-id <numeric-id>
```

Direct native commands need no API unless configured. For API-mediated control, run `control-api` and configure `DAGENT_CLI_API_URL=http://127.0.0.1:8000` or `dagent --runtime-directory "${HOME}/.local/share/dagent" cli-api config --url http://127.0.0.1:8000`.

The fixed Compose root adds no compatibility lookup. For an approved migration from `./runtime`, stop affected services, check `${HOME}/.local/share/dagent` for conflicts, and use a metadata-preserving copy such as `rsync -a`; preserve credential mode `0600`, never display secret contents, and retain the source until verification. Recreate affected containers afterward because restart alone keeps old binds.

For standalone operation without the compose `agent` service, run opencode outside the container and bind it beyond loopback so the container can reach it:

```sh
opencode serve --hostname 0.0.0.0 --port 4096
```

Start the Telegram container only after side effects are approved:

```sh
docker compose up -d telegram
```

## Rules

- Keep compose environment for `telegram` limited to `DAGENT_RUNTIME_DIRECTORY=/runtime` and `OPENCODE_SERVER_URL=http://agent:4096` unless a Telegram-owned setting is intentionally added.
- Keep the Telegram bind mount limited to `${HOME}/.local/share/dagent/data/telegram:/runtime/data/telegram`; do not expose all runtime service data to the container.
- Keep the optional Telegram Compose env file at `${HOME}/.local/share/dagent/data/telegram/.env` and out of git.
- Keep `HOME` required and the Telegram bind non-creating; use `services init compose` to prepare it.
- Keep Telegram-to-agent requests bounded by `OPENCODE_REQUEST_TIMEOUT_MS`.
- Keep `telegram.depends_on.agent.condition: service_healthy` when Telegram targets the compose `agent` service, so Telegram long polling starts only after opencode answers its health endpoint.
- Do not add non-Telegram service toggles or API settings to the Telegram compose environment.
- Keep API host/port/token settings on `control-api`; client settings belong in the host shell or runtime config.
- Preserve `telegramIndex.ts -> runTelegramService()` as the Docker service entrypoint so Docker starts only Telegram long polling.
- Do not make the Telegram Docker service start, stop, configure, or expose other services; use separate compose services for those boundaries.
- Preserve `forceTelegramEnabled: true` for the Telegram-only runner so credentials load without relying on service toggles.
- Do not include Telegram bot tokens or persisted credentials in the image build context.
- Keep runtime credentials and generated state in the mounted `/runtime` directory.
- Keep Telegram credential storage at `<runtimeDirectory>/data/telegram/credentials.json`; in the standard container this resolves to `/runtime/data/telegram/credentials.json`.
- Recreate existing `telegram` and `control-api` containers after mount or env-file changes; a restart alone does not replace a container's bind configuration.
- Keep `services/telegram/tsconfig.json` including `../../shared/**/*.ts` while Telegram source imports shared runtime helpers, so container `dist/shared/` cannot be incomplete or stale.
- Keep `services/telegram/Dockerfile.dockerignore` as a positive allowlist for only `tsconfig.json`, `shared/**`, and `services/telegram/**`; do not let unrelated service packages enter the Telegram build context.
- Do not copy root `package.json` into the Telegram Docker build or runtime image.
- Do not copy Telegram package metadata twice inside the image; `/app/package.json` and `/app/package-lock.json` are canonical for install, prune, ESM scope, and runtime metadata.
- Do not reintroduce `npm ci --prefix services/telegram`, `npm prune --prefix services/telegram`, or a build-stage `node_modules` symlink for the Telegram image unless the Docker package layout is deliberately redesigned.
- Keep dependencies relevant to Telegram in `services/telegram/package.json`; built-in Node APIs such as `fetch`, `Headers`, `URL`, and `Buffer` do not need manifest dependencies.
- Keep Telegram opencode HTTP access local to `OpencodeTelegramAgent`; do not import `services/agent` sources or dependencies into the Telegram package.
- Keep the Docker build-time import assertion for `dist/shared/utils/runtimeDirectory.js` when changing Telegram image build steps.
- Do not edit or commit generated `dist/` files to repair container ESM import errors; fix TypeScript source/config and rebuild the image.
- Do not use `dagent start` inside the container for the long-running service; prefer the Telegram-only foreground runner so Docker owns process supervision.
- Use native CLI execution without an API URL for direct runtime-file access. Use mediation intentionally through `control-api`; MCP stdio commands remain local.
- Expect Telegram session mappings to remain process-local and to reset when the container restarts.
- Avoid switching to Telegram webhooks unless explicitly requested; the current service uses long polling.

## Verification

Safe automated checks after adding or changing the Telegram container assets:

```sh
npm run typecheck
npm test
npm run build:telegram
```

Run the full build as needed when the change affects project-wide output:

```sh
npm run build
docker compose build telegram
docker compose config
```

The canonical-root regression assertions are in `test/opencodeRuntimeConfig.test.mjs`; they verify required `HOME`, long non-creating binds, narrow canonical sources, exact root config paths, provider persistence, loopback agent port, and service isolation. Run them after a build:

```sh
npm run build
node --test test/opencodeRuntimeConfig.test.mjs
docker compose config --quiet
git diff --check
```

Avoid `docker compose up telegram`, `docker compose run ...`, `npm start`, `node dist/services/telegram/src/index.js`, or `node dist/services/telegram/src/telegramIndex.js` in automated verification unless the user approves container startup, Telegram polling, opencode network, or API-server side effects. Docker verification should use `docker compose config` and relevant build/config checks only; native CLI smoke checks should run on the host after `npm run build`.

The 2026-07-22 remediation was reported verified by the 82-test suite, typecheck/builds, targeted images, Compose rendering, empty-`HOME` rejection, recreated services, and a running Telegram container with bounded opencode requests.

## Child Instructions

| Instruction File | Description |
| --- | --- |
