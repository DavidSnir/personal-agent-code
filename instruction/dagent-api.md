# DAgent HTTP Control API Instructions

## Scope

This file covers `services/cli-api`: HTTP control endpoints, authorization, Compose `control-api`, Calendar/Telegram mediation, and its implemented ownership of WAHA lifecycle, scheduled sends, and webhooks.

## Context

`services/cli-api/src/dagentApiService.ts` uses Node `node:http` and the shared `AppService` lifecycle. Native `services/telegram/src/app.ts` may construct a limited API when the `api` runtime service is enabled. Standard Compose runs `services/cli-api/src/index.ts` as service `control-api`; the source package and CLI command name remain `cli-api`.

The Compose service listens on `0.0.0.0:8000` internally and publishes `127.0.0.1:8000`. Its mounts are:

- `${HOME}/.local/share/dagent/data/google-calendar:/runtime/data/google-calendar` for Calendar OAuth/cache state.
- `${HOME}/.local/share/dagent/.settings:/runtime/.settings` for native setting reads/writes.
- `${HOME}/.local/share/dagent/opencode.json:/agent-runtime/opencode.json` for exact agent-visible config updates.
- `${HOME}/.local/share/dagent/data/telegram:/telegram-runtime/data/telegram` for proxied Telegram credentials/status without unrelated runtime data.
- `${HOME}/.local/share/dagent/data/whatsapp:/whatsapp-runtime/data/whatsapp` for WhatsApp SQLite state.
- `/var/run/docker.sock` for the guarded agent-container restart helper.

All host binds use pre-created canonical sources; run `services init compose` before container creation. The API does not receive broad access to the host runtime root.

`services/cli-api/src/index.ts` constructs `WahaClient` and `WhatsappControlService`, starts WhatsApp control before listening, and stops it after closing HTTP. If HTTP binding fails, WhatsApp control is stopped. The all-in-one native API does not receive a WhatsApp control instance and returns configuration errors for WhatsApp-only routes.

Configuration:

- `DAGENT_API_ENABLED` is the native API toggle and defaults to `false`.
- `DAGENT_API_HOSTNAME` defaults to `127.0.0.1`; Compose overrides `0.0.0.0`.
- `DAGENT_API_PORT` defaults to `8000`.
- `DAGENT_API_TOKEN` optionally requires exact `Authorization: Bearer <token>` for normal routes.
- `DAGENT_AGENT_RUNTIME_DIRECTORY`, `DAGENT_AGENT_OPENCODE_CONFIG_PATH`, and `DAGENT_AGENT_RESTART_COMMAND` govern MCP install/restart behavior.
- `DAGENT_TELEGRAM_RUNTIME_DIRECTORY` selects proxied Telegram state. Standard Compose uses `/telegram-runtime`, causing the shared helper to resolve `/telegram-runtime/data/telegram/credentials.json` against the narrow host subtree mount.
- `DAGENT_WHATSAPP_RUNTIME_DIRECTORY` selects WhatsApp SQLite/config state and is required by the Compose entrypoint.
- `WAHA_BASE_URL`, `WAHA_API_KEY`, and `WAHA_WEBHOOK_SECRET` configure WAHA requests and webhook validation.
- `WHATSAPP_SEND_TIMEOUT_MS` bounds sends; `WHATSAPP_LIFECYCLE_TIMEOUT_MS` bounds WAHA reads/lifecycle calls; startup retries share the finite `WHATSAPP_STARTUP_RECONCILE_TIMEOUT_MS` deadline and `WHATSAPP_STARTUP_RETRY_INTERVAL_MS` delay.
- WhatsApp/Calendar MCP transport variables determine generated agent config.

Compose supplies deterministic local-development WAHA credentials when interpolation variables are absent. Production must override both with independent strong values. The application still sees non-empty values and validates their presence; this is not a claim that the committed defaults are production-safe.

## Endpoints

| Method and path | Behavior |
| --- | --- |
| `GET /health` | Returns `{ "ok": true }` after bearer authorization. |
| `GET /services` | Returns all native runtime service settings. |
| `GET /services/:name` | Returns one native runtime service setting. |
| `POST /services/:name/enable` | Persists one native setting in `.settings`. |
| `POST /services/:name/disable` | Persists one native setting in `.settings`. |
| `POST /telegram/auth` | Validates and persists owner-only Telegram credentials. |
| `GET /telegram/status` | Returns non-secret Telegram credential status. |
| `POST /deployment/init` | Installs both exact Compose remote MCP entries. |
| `POST /calendar/auth/start` | Starts Calendar OAuth. |
| `GET /calendar/auth/sessions/:id` | Returns non-secret Calendar auth progress. |
| `GET /calendar/auth/callback` | Public stable OAuth callback. |
| `GET /calendar/status` | Returns non-secret Calendar cache and credential status. |
| `POST /calendar/sync` | Runs one Calendar sync using stored credentials. |
| `POST /whatsapp/init` | Reconciles `default` and installs remote WhatsApp MCP. |
| `GET /whatsapp/status` | Returns WAHA, inbox, contact, and schedule status. |
| `POST /whatsapp/logout` | Logs out WAHA session `default`. |
| `POST /whatsapp/auth/start` | Starts/polls WAHA QR authorization state. |
| `GET /whatsapp/auth/sessions/:id` | Returns QR art/progress and installs MCP on completion. |
| `POST /whatsapp/sync/start` | Starts asynchronous WAHA contact synchronization. |
| `GET /whatsapp/sync/sessions/:id` | Returns contact sync progress. |
| `POST /internal/whatsapp/webhook` | HMAC-only durable WAHA event ingestion. |
| `POST /cli` | Always rejects broad command execution with `400`. |

`POST /start`, `POST /stop`, and native detached/internal lifecycle route spellings are also rejected with `400`. Unknown generic routes, including generic init spellings, remain `404`; deployment initialization uses only `POST /deployment/init`.

The Calendar callback and WhatsApp webhook are the only routes before normal bearer authorization. Calendar uses OAuth state validation. WhatsApp uses exact raw-body HMAC-SHA512 only; bearer tokens neither replace nor supplement webhook HMAC.

The webhook route accepts at most 1 MiB, requires a 128-character hex `X-Webhook-Hmac`, validates event ID/session/type, durably deduplicates by ID, returns `200` before handlers run, and wakes asynchronous processing for new events. See `instruction/whatsapp.md` for its durable lifecycle contract.

## Native CLI Mediation

`dagent cli-api config --url http://127.0.0.1:8000` stores runtime-scoped connection settings under `data/dagent/cli-api.json`. Env precedence is `DAGENT_CLI_API_URL`, then stored URL; token precedence is `DAGENT_CLI_API_TOKEN`, `DAGENT_API_TOKEN`, then stored token. Output reports token presence, never value.

All supported remote app-control commands use dedicated endpoints. List/status/enable/disable map to `/services...`; Telegram, Calendar, WhatsApp, and deployment initialization have explicit routes. WhatsApp lifecycle commands fail without a configured API URL. Help, completion, API config, runtime-default config, and `services mcp calendar|whatsapp` remain local. Broad `/cli` execution was removed rather than repaired.

Native CLI requests use `AbortSignal` with `DAGENT_CLI_API_TIMEOUT_MS` defaulting to `120000` and capped at `600000`. Timeouts identify the path and configuration variable. When any CLI API URL is effective, native `start`, `stop`, and private detached execution are blocked before network routing to prevent duplicate native supervision beside Compose.

`POST /telegram/auth` is a normal bearer-authorized route accepting JSON `{ "botToken": string, "userId": string | number }`. It uses `DAGENT_TELEGRAM_RUNTIME_DIRECTORY` when configured, otherwise the API runtime directory, and shared `shared/utils/telegramCredentials.ts` logic writes `<telegramRuntimeDirectory>/data/telegram/credentials.json`. The helper trims and requires a non-empty token, requires a positive safe-integer numeric user ID, creates the service directory with mode `0700`, and enforces credential-file mode `0600`. The response contains `credentialsPath`, `botTokenPresent`, numeric `allowedUserId`, and `updatedAt`, never the token. Standard Compose's narrow mount maps this path to host `${HOME}/.local/share/dagent/data/telegram/credentials.json`.

On deployment init, completed Calendar auth, or WhatsApp init/auth, control-api may install remote MCP entries and restart `dagent-agent`. Standard Compose's configured path is `/agent-runtime/opencode.json`, backed by root host `opencode.json`. Restart is attempted only when the installed path exactly matches the configured agent path; missing socket/configuration, mismatches, and command failures are reported without invalidating successful auth or token storage.

## Build Boundary

`services/cli-api/Dockerfile` installs only `services/cli-api/package-lock.json` but intentionally copies source from Agent, Calendar, CLI API, shared helpers, and `services/whatsapp/src/whatsapp`. Control-api owns `better-sqlite3` and `qrcode-terminal` because it now runs the WhatsApp repository and renders WAHA QR payloads. It must remain free of `whatsapp-web.js`, Puppeteer, and Chromium.

The image intentionally does not need the native CLI entrypoint because broad `/cli` subprocess execution is disabled. Add operations through narrowly validated API routes instead of copying the CLI into this privileged image.

Keep root `package.json` beside root `tsconfig.json` in the build stage so NodeNext emits ESM correctly. The standard image runs as root because Docker socket group IDs vary; treat this as privileged host control.

## Rules

- Keep the default API bind loopback and default port `8000`.
- Use service name `control-api` in Compose; retain `services/cli-api` and `dagent cli-api config` names.
- Require exact bearer matching when `DAGENT_API_TOKEN` is set and never print tokens.
- Keep Calendar callback and WhatsApp webhook authentication distinct from bearer authorization.
- Keep webhook HMAC over exact raw bytes, event-ID dedupe before `200`, and asynchronous processing after response.
- Keep WhatsApp control responses non-secret: QR art is allowed, raw QR data, webhook bodies, secrets, and full message text are not.
- Preserve the separate WhatsApp runtime mount and graceful stop ordering for active sends/processors before SQLite closes.
- Preserve the narrow Telegram subtree mount; do not broaden control-api access to unrelated host runtime data.
- Keep Telegram credential reading and writing centralized in `shared/utils/telegramCredentials.ts`; the Telegram service compatibility module should re-export it.
- Keep `/telegram/auth` behind normal bearer authorization and exclude bot tokens from success and error responses.
- Keep broad `/cli`, remote native supervisor operations, and detached internals rejected; add dedicated routes for reviewed operations.
- Keep CLI API requests bounded by the validated timeout and preserve actionable timeout errors.
- Do not reintroduce a worker-control URL or proxy to a removed `whatsapp-worker`; control-api owns WAHA integration directly.
- Preserve verified-config gates before Docker socket restart operations.
- Require `DAGENT_API_TOKEN` and an intentional network/security design before publishing beyond loopback.

## Verification

```sh
npm run typecheck
npm test
npm run build
npm run build:cli-api
env -u WAHA_API_KEY -u WAHA_WEBHOOK_SECRET docker compose config
docker compose build control-api
node --test test/dagentApiOauthRedirect.test.mjs
node --test test/dagentApiAgentRestart.test.mjs
node --test test/dagentApiTelegramAuth.test.mjs
node --test test/dagentApiRouting.test.mjs
node --test test/wahaWebhook.test.mjs
git diff --check
```

The 2026-07-22 remediation was reported verified with 82 tests, full typecheck/builds, targeted images, dedicated routing tests, and live loopback control health. Broad `/cli`, supervisor, and detached routes were confirmed rejected. Calendar worker/MCP and WhatsApp MCP were healthy. WAHA pairing was not restored: the session reached `FAILED` and still requires QR re-pairing.

After changing any mount, recreate `control-api`; restart alone retains old bind configuration.

## Child Instructions

| Instruction File | Description |
| --- | --- |
| instruction/whatsapp.md | WAHA lifecycle, security, storage, sends, and MCP rules. |
