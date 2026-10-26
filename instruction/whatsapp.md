# WhatsApp WAHA Integration

## Scope

This file covers the implemented WhatsApp subsystem: Compose-only WAHA GOWS runtime, control-API lifecycle and scheduled sends, authenticated webhooks, durable SQLite state, exact-recipient scheduling, and database-only MCP access.

## Context

WhatsApp is no longer a native supervisor service. The removed implementation used `whatsapp-web.js`, LocalAuth, Puppeteer, Chromium, and native/detached workers; do not restore those paths. Standard Compose now has three boundaries:

- `waha` is the only live WhatsApp connection and owns one session named `default` using engine `GOWS`.
- `control-api` uses source package `services/cli-api`, owns session reconciliation, QR auth, contact sync, scheduled sends, webhook ingestion/processing, and the WhatsApp SQLite database.
- `whatsapp-mcp` is database-only and schedules messages; it never contacts WAHA.

Important files:

- `docker-compose.yml` pins and configures WAHA, `control-api`, and `whatsapp-mcp`.
- `services/cli-api/src/index.ts` constructs `WahaClient` and `WhatsappControlService`.
- `services/cli-api/src/whatsapp/wahaClient.ts` implements bounded authenticated WAHA HTTP requests.
- `services/cli-api/src/whatsapp/whatsappControlService.ts` owns lifecycle, sync, sends, and graceful shutdown.
- `services/cli-api/src/whatsapp/webhook.ts` validates exact raw-body HMAC-SHA512 signatures and envelopes.
- `services/cli-api/src/whatsapp/webhookProcessor.ts` processes the durable inbox asynchronously.
- `services/whatsapp/src/whatsapp/repository.ts` owns contacts, schedules, WAHA lifecycle records, message state, acknowledgements, and webhook inbox state.
- `services/whatsapp/src/whatsapp/config.ts` loads DB path, poll interval, separate send/lifecycle request timeouts, and startup reconciliation deadline/retry settings.
- `services/whatsapp/src/mcp/whatsappMcpServer.ts` implements local stdio and Compose HTTP MCP tools.
- `cli/src/cli.ts` keeps WhatsApp lifecycle commands remote-only and the local MCP command database-only.

## Compose and Configuration

WAHA is pinned for `linux/amd64` to:

```text
devlikeapro/waha:gows-2026.7.1@sha256:8f3a7b11310594b973a588b2f7de061864c83532ae2cdff43280db0402bead29
```

WAHA listens on port `3000` only inside the Compose network; it has no host `ports` mapping. Its dashboard, Swagger, console QR output, and media downloads are disabled. `${HOME}/.local/share/dagent/data/whatsapp/waha-sessions` is mounted at `/app/.sessions`, `WHATSAPP_START_SESSION=default`, and `WAHA_WORKER_RESTART_SESSIONS=true` request default-session restoration. The authenticated healthcheck sends `X-Api-Key` to `GET /health`.

`control-api` mounts `${HOME}/.local/share/dagent/data/whatsapp` at `/whatsapp-runtime/data/whatsapp`, reaches WAHA at `http://waha:3000`, and publishes only `127.0.0.1:8000:8000`. Configure the native CLI with:

```sh
dagent --runtime-directory <live-folder> cli-api config --url http://127.0.0.1:8000
```

Existing runtime CLI API settings using port `7331` are obsolete and must be updated.

Environment values:

- `WAHA_BASE_URL` is `http://waha:3000` in standard Compose.
- `WAHA_API_KEY` authenticates health checks and every control-API WAHA request.
- `WAHA_WEBHOOK_SECRET` configures WAHA webhook HMAC and control-API raw-body validation.
- `WHATSAPP_DB_PATH` defaults to `<runtimeDirectory>/data/whatsapp/whatsapp.sqlite`.
- `WHATSAPP_WORKER_INTERVAL_SECONDS` defaults to `60` and controls control-API due-message polling.
- `WHATSAPP_SEND_TIMEOUT_MS` defaults to `120000` and bounds scheduled sends, with maximum `600000`.
- `WHATSAPP_LIFECYCLE_TIMEOUT_MS` defaults to `10000` and bounds WAHA session/read/lifecycle requests, with maximum `120000`.
- `WHATSAPP_STARTUP_RECONCILE_TIMEOUT_MS` defaults to `30000` and is the total startup reconciliation deadline, with maximum `300000`.
- `WHATSAPP_STARTUP_RETRY_INTERVAL_MS` defaults to `1000` between failed reconciliation attempts, with maximum `30000`.
- `DAGENT_WHATSAPP_RUNTIME_DIRECTORY` is `/whatsapp-runtime` in Compose.
- `DAGENT_WHATSAPP_MCP_TRANSPORT=remote` and `DAGENT_WHATSAPP_MCP_REMOTE_URL=http://whatsapp-mcp:7333/mcp` install the agent-visible remote MCP entry.

The Compose file deliberately uses deterministic local-development fallbacks:

```text
WAHA_API_KEY=local-development-waha-api-key-change-me
WAHA_WEBHOOK_SECRET=local-development-waha-webhook-secret-change-me
```

Therefore `docker compose config` and `docker compose up` do not require operators to define either variable. These committed defaults are only for local development. Production must override both with strong, independent values through Compose interpolation, such as exported shell variables, the Compose project `.env`, or a production override file. Because explicit `environment` entries override `env_file`, do not assume `${HOME}/.local/share/dagent/data/whatsapp/.env` alone replaces the interpolation defaults. Never reuse the defaults in an exposed deployment.

## Session Lifecycle and CLI

The only supported lifecycle commands are:

```sh
dagent --runtime-directory <live-folder> services init whatsapp
dagent --runtime-directory <live-folder> services auth whatsapp
dagent --runtime-directory <live-folder> services sync whatsapp
dagent --runtime-directory <live-folder> services logout whatsapp
dagent --runtime-directory <live-folder> services status whatsapp
dagent --runtime-directory <live-folder> services mcp whatsapp
```

On a fresh standard Compose root, first run local `dagent --runtime-directory "${HOME}/.local/share/dagent" services init compose` before configuring the CLI API URL or creating containers. Remote `/deployment/init` updates MCP configuration only; it cannot prepare missing host bind sources.

`init`, `auth`, `sync`, `logout`, and `status` require `DAGENT_CLI_API_URL` or runtime `cli-api config`. Native `services start whatsapp`, `services stop whatsapp`, and the `WHATSAPP_ENABLED` service toggle were removed. `services mcp whatsapp` remains local because it is a stdio protocol server and accesses SQLite only.

At control-API startup, `WhatsappControlService` initializes SQLite, resets interrupted scheduled rows from `sending` to `pending`, and retries reconciliation only within one finite overall deadline. Each WAHA lifecycle request is also bounded by the shorter lifecycle timeout and remaining overall deadline. On success it starts the webhook processor and due-message interval. Reconciliation lists sessions, creates and starts `default` when absent, starts it when `STOPPED`, requires engine `GOWS`, persists current status, and never deletes unexpected sessions. Status is unhealthy when `default` is not `WORKING`, the engine is not `GOWS`, or another active session exists.

The pinned `gows-2026.7.1` response contracts are asymmetric. The exact observed read-only list entry had no `engine` field:

```json
{
  "name": "default",
  "status": "FAILED",
  "config": null,
  "presence": null,
  "timestamps": {}
}
```

The corresponding `GET /api/sessions/default` detail included this top-level field:

```json
{
  "engine": {
    "grpc": { "client": "READY", "stream": "READY" },
    "gows": { "found": true, "connected": false }
  }
}
```

There is no `engine.engine` string in that live detail shape. Session parsing identifies GOWS from the presence of the `engine.gows` object while retaining support for string and nested `engine.engine` response forms. `WahaClient.listSessions()` must remain the reconciliation source so unexpected sessions are visible, but when its parsed `default` entry lacks engine metadata it performs one bounded, API-key-authenticated detail lookup and replaces that entry with the detailed result. It must not perform the detail lookup when the list already provides the default engine or when no default entry exists.

This response adaptation does not relax lifecycle validation. Session parsing normalizes status and engine strings to uppercase, and `WhatsappControlService` still rejects `default` when the resolved engine is missing or differs from `GOWS`. Do not infer GOWS from an arbitrary engine object, the image tag, Compose defaults, or a running status; a missing detail response or detail response without a string discriminator, nested `engine.engine`, or `engine.gows` object must still fail reconciliation with `WAHA default session must use GOWS`.

Auth polls WAHA session state. `SCAN_QR_CODE` triggers `POST /api/default/auth/qr?format=raw`; control-api renders the payload with `qrcode-terminal` and returns only terminal art. `WORKING` completes auth and `FAILED` fails it. Logout calls the WAHA default-session logout endpoint and records `STOPPED`. Old LocalAuth/browser profiles cannot be migrated; pair GOWS once by QR.

Sync requires `default` to be `WORKING`, fetches `/api/contacts/all?session=default` and `/api/default/chats?limit=1000`, and caches chat-backed `@c.us` and `@g.us` recipients. Contact-only records do not become schedulable.

## Exact Recipient and Scheduled Send Rules

Scheduling resolves trimmed display names by case-sensitive exact match first, then a unique case-insensitive exact match. Missing or ambiguous names fail. Fuzzy, substring, or inferred matching is discovery-only and must never select a send recipient.

The control API polls due `pending` rows in batches of 25. It sends only while `default` is `WORKING`, uses an atomic `pending` to `sending` claim, continues after individual failures, and avoids overlapping interval-triggered loops. The exact send request is:

```http
POST http://waha:3000/api/sendText
X-Api-Key: <WAHA_API_KEY>
Content-Type: application/json

{"session":"default","chatId":"<cached @c.us or @g.us id>","text":"<stored message>"}
```

A successful response must contain a WAHA message ID. The repository stores that ID on the scheduled row and in normalized `waha_messages`; later `message.ack` events correlate acknowledgement code/name/time back to the schedule. One-shot and inclusive-end recurring schedule behavior is unchanged. Startup recovery can cause an interrupted send to be retried, so inspect ambiguous `sending` cutovers before production migration.

## Webhook Security and Durable Processing

WAHA posts only these events to `http://control-api:8000/internal/whatsapp/webhook`:

```text
message,message.ack,message.edited,message.revoked,session.status
```

The webhook route is before normal bearer authorization and uses only dedicated HMAC authentication. It:

1. Requires a 128-hex-character `X-Webhook-Hmac` header.
2. Reads at most 1 MiB of exact raw body bytes.
3. Computes HMAC-SHA512 with `WAHA_WEBHOOK_SECRET` and uses constant-time comparison.
4. Requires valid UTF-8 JSON, non-empty event `id`, session `default`, and one subscribed event type.
5. Inserts the raw payload into `waha_webhook_inbox` using event ID as the unique key.
6. Returns `200` for new and duplicate valid events before business processing.
7. Schedules asynchronous processing only for newly inserted events.

Missing/invalid signatures return `401`, malformed signed envelopes return `400`, and oversized bodies return `413`. Normal API bearer tokens do not authenticate this route.

Inbox states are `pending`, `processing`, `processed`, and `failed`. Claims are atomic, interrupted `processing` rows recover on startup, handlers retry up to five attempts, and successful rows retain their dedupe ID but clear the raw payload. Processing normalizes session status, message identity/direction/chat/sender/body/media-presence metadata, acknowledgement state, edits, and revocations. It does not store engine `_data` or downloaded media. Graceful shutdown waits for the active send and webhook processor before closing SQLite.

## SQLite and MCP

The repository enables SQLite WAL and foreign keys. Durable tables include:

- `whatsapp_contacts` for currently sendable chat-backed names and IDs.
- `scheduled_whatsapp_messages` for schedule state, recurrence, WAHA IDs, and acknowledgement state.
- `waha_sessions` for latest normalized session status and engine.
- `waha_messages` for normalized message lifecycle state.
- `waha_webhook_inbox` for event-ID dedupe and durable asynchronous processing.

The MCP server remains database-only. It offers scheduling, recipient discovery, schedule listing, cancellation, and non-secret status. Local stdio uses `dagent services mcp whatsapp`; Compose HTTP MCP is `http://whatsapp-mcp:7333/mcp`. Do not import WAHA client/control code into MCP or make MCP tools perform immediate sends.

## Rules

- Keep WAHA Compose-only and keep exactly one expected session named `default` using `GOWS`.
- Do not publish WAHA port `3000`; keep dashboard and Swagger disabled.
- Persist `/app/.sessions`; never delete session data automatically to repair lifecycle errors.
- Keep send timeout, lifecycle timeout, and total startup reconciliation deadline separate and bounded.
- Keep local Compose credential defaults deterministic, but require production overrides with strong independent secrets.
- Never log API keys, webhook secrets, raw QR payloads, webhook bodies, session data, recipient names, or full scheduled-message bodies.
- Preserve exact authenticated `/api/sendText` URL, headers, and payload fields.
- Gate contact sync and sends on `WORKING` and enforce `GOWS` responses.
- Keep list-based session reconciliation; enrich only a listed engine-less `default` through its detail endpoint.
- Never treat missing engine metadata as GOWS or weaken strict engine validation.
- Keep event-ID dedupe, exact raw-body HMAC-SHA512 verification, immediate acknowledgement, and asynchronous durable processing.
- Keep message and session lifecycle state monotonic by event timestamps where repository upserts enforce it.
- Keep native WhatsApp worker toggles, supervisor wiring, detached commands, browser code, LocalAuth, Chromium, Puppeteer, and `whatsapp-web.js` removed.
- Keep `qrcode-terminal` in `services/cli-api` only; do not return the raw QR payload.
- Treat `docker compose up`, pairing, sync, real webhooks, real sends, logout, and WAHA restart tests as side-effecting live operations.

## Verification

Safe checks:

```sh
npm ci
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

Focused tests are `test/wahaClient.test.mjs`, `test/wahaControlService.test.mjs`, `test/wahaWebhook.test.mjs`, `test/opencodeRuntimeConfig.test.mjs`, and WhatsApp repository/MCP tests. The engine-response regression is covered by the first two files: the client test verifies the authenticated list-then-detail request sequence and exact observed `engine.gows` shape while retaining string and nested-engine parsing, and the control-service test verifies that unresolved engine metadata still fails GOWS enforcement. Run those two tests after building:

```sh
npm run build
node --test test/wahaClient.test.mjs test/wahaControlService.test.mjs
```

The full 2026-07-22 remediation passed 82 tests, including the finite startup-deadline regression, plus typecheck/builds, targeted images, and Compose checks. Canonical WhatsApp DB reconciliation passed integrity checks with no due or `sending` rows; MCP and WAHA container health were verified, with WAHA internal and GOWS-based.

Pairing restoration did **not** pass: the persisted `default` session transitioned to `FAILED`. The operator must QR re-pair before `WORKING`, sync, send, or restart restoration can be claimed. After re-pairing, live verification should confirm `WORKING`, sync contacts, test an approved webhook/send, restart WAHA, and check whether authentication survives; do not assume it will.

## Child Instructions

| Instruction File | Description |
| --- | --- |
| instruction/whatsapp-containerization-plan.md | WAHA, control API, MCP, and Compose deployment boundaries. |
