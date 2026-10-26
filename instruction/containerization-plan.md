# Containerization Instructions

## Scope

This file covers project-level Compose organization, runtime mounts, service boundaries, and safe Docker verification. Follow child instructions for subsystem detail.

## Context

`docker-compose.yml` defines seven services:

- `agent`: opencode on container port `4096` and loopback host port `4096`, exact root config, persistent provider data, and Node healthcheck.
- `telegram`: Telegram-only polling against healthy `agent`.
- `control-api`: source package `services/cli-api`, loopback host port `8000`, Calendar/Telegram/WhatsApp control, agent MCP config writes, and Docker restart helper.
- `calendar-worker`: Google Calendar background cache sync.
- `calendar-mcp`: database/live-tool MCP at Docker DNS `calendar-mcp:7332/mcp`.
- `waha`: pinned internal browserless GOWS runtime on container port `3000` only.
- `whatsapp-mcp`: database-only MCP at Docker DNS `whatsapp-mcp:7333/mcp`.

Runtime organization:

```text
${HOME}/.local/share/dagent/
  .settings
  opencode.json
  agent/.env
  agent/workspace/
  data/google-calendar/.env
  data/google-calendar/google-calendar.sqlite
  data/opencode/
  data/telegram/.env
  data/telegram/credentials.json
  data/whatsapp/.env
  data/whatsapp/whatsapp.sqlite
  data/whatsapp/waha-sessions/
```

Run `dagent --runtime-directory "${HOME}/.local/share/dagent" services init compose` before first container creation. Compose requires non-empty `HOME`, uses long bind syntax with `create_host_path: false`, and mounts only required files/subtrees. Real runtime files are host-mounted; never bake them into images. The agent reaches MCP services through Docker DNS, not localhost.

The host root `opencode.json` is mounted read-only at `/runtime/opencode.json` for the agent and writable at `/agent-runtime/opencode.json` for control-api. `OPENCODE_CONFIG=/runtime/opencode.json` makes it the exact config OpenCode reads. OpenCode provider data/auth persists separately from workspace files through `data/opencode:/root/.local/share/opencode` because the agent image runs OpenCode as root.

## Control and WhatsApp Boundaries

Compose renamed only the service from `cli-api` to `control-api`; source, image Dockerfile, package name, and native `dagent cli-api config` remain unchanged. Host sources are rooted at `${HOME}/.local/share/dagent`; container destinations expose Calendar at `/runtime/data/google-calendar`, exact agent config at `/agent-runtime/opencode.json`, Telegram at `/telegram-runtime/data/telegram`, and WhatsApp at `/whatsapp-runtime/data/whatsapp`, plus `.settings` and the Docker socket. Host clients use `http://127.0.0.1:8000`.

WAHA is not built from repository source. It uses the exact pinned image and digest documented in `instruction/whatsapp.md`, has no host port, persists `/app/.sessions`, disables dashboard/Swagger/QR/media download, and sends signed webhooks to control-api. `services/whatsapp/Dockerfile` is now MCP-only and does not install Chrome or browser dependencies.

Both WAHA credential variables have deterministic Compose interpolation defaults for local development. Secret-free `docker compose config` and local `docker compose up` are intentional. Production must override both values with strong independent secrets in the Compose interpolation environment. Optional service `env_file` entries preserve unrelated targeted build/config behavior but are not the production override mechanism when explicit `environment` values take precedence.

## Docker Build Rules

Service Dockerfiles use independent package manifests and service-scoped TypeScript builds. Nested TypeScript images copy root `package.json` beside root `tsconfig.json` so NodeNext sees the repository ESM package scope, but install only the owning package lock.

- Telegram source closure remains Telegram plus shared helpers.
- Calendar source closure remains Calendar plus shared helpers.
- WhatsApp image source closure remains WhatsApp plus shared helpers and runs HTTP MCP only.
- Control-api intentionally composes Agent, Calendar, CLI API, shared, and WhatsApp config/repository source.
- Control-api runs as root in standard Compose for Docker socket access; treat the mount as privileged host control.

## Rules

- Keep each service's runtime state in mounted ignored folders; never copy `.env`, `.settings`, SQLite, OAuth tokens, Telegram credentials, WAHA sessions, logs, or generated config into images.
- Keep the fixed Compose host root `${HOME}/.local/share/dagent` and narrow Telegram subtree mount; do not make binds repository-relative.
- Keep non-empty `HOME`, `create_host_path: false`, and the `services init compose` prerequisite.
- Keep `4096` and `8000` loopback-only and keep both MCP ports internal.
- Keep exact root `opencode.json` mounts and provider data at `/root/.local/share/opencode`.
- Keep `telegram` dependent on healthy `agent` and keep Telegram's container entrypoint Telegram-only.
- Keep Calendar worker and MCP lifecycle separate.
- Keep service name `control-api`, loopback host binding `127.0.0.1:8000`, and source path `services/cli-api`.
- Keep WAHA internal, pinned, GOWS-only, persistent, authenticated, and without host port `3000`.
- Keep WhatsApp MCP database-only; do not reintroduce a browser worker image.
- Keep local WAHA fallback credentials for deterministic development; require production overrides operationally.
- Keep Docker socket restart path gated by exact agent config-path checks.
- Do not add a Compose CLI service/profile; the operator CLI runs natively.
- Do not run `dagent start` inside service containers; Docker owns foreground supervision.

## Verification

```sh
npm run typecheck
npm test
npm run build
env -u WAHA_API_KEY -u WAHA_WEBHOOK_SECRET docker compose config
docker compose build telegram
docker compose build calendar-worker calendar-mcp
docker compose build control-api
docker compose build whatsapp-mcp
git diff --check
```

Use config/build checks without startup. `docker compose up`, OAuth, Telegram polling, QR pairing, WAHA webhooks, and real sends are side-effecting. The 2026-07-22 remediation did rebuild/recreate all seven approved services and verified loopback health and persistence; WAHA remained `FAILED` at the pairing layer and still requires QR re-pairing.

Compose mount and env-file edits affect newly created containers only. For an approved move from `./runtime`, stop affected services, reject destination conflicts, copy with metadata preservation (for example `rsync -a`), verify ownership/modes without reading secrets, and retain the source until validation. Recreate all affected services before live validation; restart alone is insufficient. Documentation-safe verification must not migrate data or recreate services.

## Child Instructions

| Instruction File | Description |
| --- | --- |
| instruction/telegram-container.md | Telegram container boundary, configuration, setup, and verification. |
| instruction/calendar-containerization-plan.md | Calendar worker, MCP, storage, and auth boundaries. |
| instruction/whatsapp-containerization-plan.md | WAHA, control API, MCP, and storage boundaries. |
| instruction/service-dependency-split-plan.md | Independent package dependencies and Docker build rules. |
| instruction/compose-runtime.md | Canonical host paths, initialization, persistence, and migration status. |
