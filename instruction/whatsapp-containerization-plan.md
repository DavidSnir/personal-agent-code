# WhatsApp Containerization

## Scope

This file covers the implemented Compose deployment for internal WAHA GOWS, the WhatsApp-owning control API, persistent session and SQLite storage, and database-only WhatsApp MCP.

## Context

Standard Compose uses three services:

```text
waha
  -> pinned linux/amd64 browserless GOWS image
  -> internal http://waha:3000 only
  -> one persistent default session in /app/.sessions

control-api
  -> services/cli-api image and source package
  -> loopback host API at http://127.0.0.1:8000
  -> WAHA lifecycle, QR, sync, sends, webhooks, SQLite

whatsapp-mcp
  -> services/whatsapp database-only image
  -> internal http://whatsapp-mcp:7333/mcp
  -> shared WhatsApp SQLite, no WAHA connection
```

The old `whatsapp-worker` service, Chrome installation, Puppeteer flags, LocalAuth browser profile, port `7334`, and browser worker entrypoints were removed. `services/whatsapp/Dockerfile` now builds and runs only `dist/services/whatsapp/src/mcp/httpIndex.js`; it must remain free of browser packages.

## Compose Shape

- `waha` uses `devlikeapro/waha:gows-2026.7.1@sha256:8f3a7b11310594b973a588b2f7de061864c83532ae2cdff43280db0402bead29` with `platform: linux/amd64`.
- WAHA has no host `ports`; `WHATSAPP_API_HOSTNAME=0.0.0.0` and `WHATSAPP_API_PORT=3000` are internal only.
- `${HOME}/.local/share/dagent/data/whatsapp/waha-sessions:/app/.sessions` persists pairing state.
- `WHATSAPP_DEFAULT_ENGINE=GOWS`, `WHATSAPP_START_SESSION=default`, and `WAHA_WORKER_RESTART_SESSIONS=true` define restoration behavior.
- `WAHA_DASHBOARD_ENABLED=false`, `WHATSAPP_SWAGGER_ENABLED=false`, `WAHA_PRINT_QR=false`, and `WHATSAPP_DOWNLOAD_MEDIA=false` reduce exposed/debug surfaces.
- The WAHA healthcheck authenticates `GET /health` with `X-Api-Key`.
- WAHA posts exactly five event types to `http://control-api:8000/internal/whatsapp/webhook` and uses HMAC plus bounded linear retries.
- `control-api` builds `services/cli-api/Dockerfile`, mounts narrow Calendar/Telegram/WhatsApp data subtrees, `.settings`, and exact root config at `/agent-runtime/opencode.json`.
- `control-api` publishes `127.0.0.1:8000:8000`, depends on healthy WAHA, and reaches it at `WAHA_BASE_URL=http://waha:3000`.
- `whatsapp-mcp` mounts `${HOME}/.local/share/dagent/data/whatsapp:/runtime/data/whatsapp`, serves port `7333` only on Docker DNS, and shares the SQLite database with `control-api`.

Both `waha` and `control-api` list optional `${HOME}/.local/share/dagent/data/whatsapp/.env` files, so their absence never blocks Compose parsing. More importantly, explicit Compose `environment` values use deterministic fallback interpolation for `WAHA_API_KEY` and `WAHA_WEBHOOK_SECRET`, so local `docker compose up` also works without defining them. Production must override both interpolation variables with strong independent values; explicit environment entries take precedence over same-named `env_file` values.

## Image Boundaries

`services/cli-api/Dockerfile` intentionally copies `services/whatsapp/src/whatsapp` because control-api compiles and owns WhatsApp config/repository code. Its package owns `better-sqlite3` and `qrcode-terminal`; it does not use `whatsapp-web.js` or Puppeteer.

`services/whatsapp/Dockerfile` uses the independent package build pattern, copies root `package.json` with `tsconfig.json` for NodeNext ESM scope, installs only the WhatsApp package lock, and runs as the non-root `node` user. Its runtime command is the HTTP MCP entrypoint. The WhatsApp package owns MCP, SQLite, dotenv, and zod dependencies only.

## Storage and Network Rules

- WAHA session state: `${HOME}/.local/share/dagent/data/whatsapp/waha-sessions` on host, `/app/.sessions` in WAHA.
- WhatsApp SQLite: `${HOME}/.local/share/dagent/data/whatsapp/whatsapp.sqlite` through `/whatsapp-runtime/data/whatsapp` in control-api and `/runtime/data/whatsapp` in MCP.
- Agent MCP config: root `${HOME}/.local/share/dagent/opencode.json`, written through `/agent-runtime/opencode.json` and read by agent at `/runtime/opencode.json`.
- WAHA API: Compose network only at `waha:3000`; never publish it in production.
- Control API: loopback only at `127.0.0.1:8000` by default.
- MCP: Compose network only at `whatsapp-mcp:7333/mcp`.

Old `runtime/whatsapp/browser-profile` or LocalAuth files are historical data only. Do not delete them during migration without explicit approval, but no current service reads them.

## Rules

- Keep WAHA image tag and digest pinned together and preserve `linux/amd64` unless a deliberate upgrade is tested.
- Keep WAHA internal with no host port mapping, disabled dashboard/Swagger, authenticated healthcheck, and persistent `/app/.sessions`.
- Keep one expected `default` GOWS session and report unexpected active sessions rather than deleting them.
- Keep local development defaults non-secret and deterministic; production must override both WAHA credentials.
- Require non-empty `HOME`, initialize binds with `services init compose`, and preserve `create_host_path: false`.
- Keep separate bounded send/lifecycle timeouts and one finite startup reconciliation deadline.
- Keep the webhook URL, subscribed event set, HMAC secret mapping, and retries aligned with control-api validation.
- Keep `control-api` as the Compose service name while retaining the source/package folder `services/cli-api`.
- Keep `whatsapp-mcp` database-only and free of WAHA/browser lifecycle code.
- Do not reintroduce `whatsapp-worker`, browser-profile mounts, Chromium, Puppeteer, LocalAuth, or port `7334`.
- Treat Docker socket access by control-api as privileged host control; preserve loopback publishing and use `DAGENT_API_TOKEN` for broader exposure.
- Do not bake runtime secrets, session state, SQLite, or generated config into images.

## Verification

```sh
npm run typecheck
npm test
npm run build
npm run build:cli-api
npm run build:whatsapp
env -u WAHA_API_KEY -u WAHA_WEBHOOK_SECRET docker compose config
docker compose build control-api
docker compose build whatsapp-mcp
git diff --check
```

Inspect rendered Compose to confirm the pin, no WAHA host port, session mount, disabled UI surfaces, exact webhook URL/events, local defaults, loopback `8000`, and no `whatsapp-worker` or browser-profile mount.

The 2026-07-22 remediation included static checks, targeted images, and approved live recreation. WAHA was healthy with no host port, and canonical WhatsApp SQLite integrity passed, but persisted pairing reached `FAILED`; QR re-pair and restart-to-`WORKING` restoration remain unresolved.

## Child Instructions

| Instruction File | Description |
| --- | --- |
