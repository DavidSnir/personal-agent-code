# WAHA GOWS Migration Plan

## Implementation State

Implemented and remediated in the current working tree. This file is the historical approved plan and acceptance checklist; `instruction/whatsapp.md`, `instruction/dagent-api.md`, `instruction/whatsapp-containerization-plan.md`, and `instruction/compose-runtime.md` are authoritative for current behavior. The final user decision changed credential handling from startup-required secrets to deterministic local Compose defaults with mandatory production overrides.

## Scope

Replace the browser-backed `whatsapp-web.js` worker with one internal WAHA container using the browserless `GOWS` engine. WAHA becomes the only WhatsApp runtime. The control API owns scheduled sends, WAHA session orchestration, contact synchronization, and durable webhook processing.

The agreed deployment model is:

- Compose-only WAHA; remove native supervisor and detached WhatsApp workers.
- Durable webhook inbox and normalized session/message lifecycle state in SQLite.
- Rename the Compose `cli-api` service to `control-api` and use port `8000` internally and on the loopback host mapping.
- Preserve CLI `init`, `auth`, `sync`, `logout`, and `status` operations as control-API proxies.

## 1. Replace the Worker Container

- Remove the Compose `whatsapp-worker` service.
- Add a `waha` service using the existing `linux/amd64` deployment target and pin:

  ```text
  devlikeapro/waha:gows-2026.7.1@sha256:8f3a7b11310594b973a588b2f7de061864c83532ae2cdff43280db0402bead29
  ```

- Set `WHATSAPP_DEFAULT_ENGINE=GOWS`.
- Bind WAHA to `0.0.0.0:3000` inside Docker.
- Do not add a host `ports` mapping for WAHA.
- Persist `${HOME}/.local/share/dagent/data/whatsapp/waha-sessions:/app/.sessions`.
- Set `WAHA_DASHBOARD_ENABLED=false` and `WHATSAPP_SWAGGER_ENABLED=false`.
- Disable console QR output and automatic media downloads.
- Add an authenticated internal health check.
- Keep WAHA reachable only through the Compose network. Do not expose port `3000` in production.

## 2. Configure Secrets and Webhooks

- Keep optional `${HOME}/.local/share/dagent/data/whatsapp/.env` service env files, but use explicit deterministic interpolation fallbacks so local `docker compose up` does not require either credential.
- Production must override `WAHA_API_KEY` and `WAHA_WEBHOOK_SECRET` with strong independent values through the Compose interpolation environment. Explicit `environment` values override same-named `env_file` values.
- Set `WAHA_BASE_URL=http://waha:3000` on WAHA and `control-api`.
- Configure WAHA to post webhooks to:

  ```text
  http://control-api:8000/internal/whatsapp/webhook
  ```

- Subscribe only to:

  ```text
  message
  message.ack
  message.edited
  message.revoked
  session.status
  ```

- Map `WAHA_WEBHOOK_SECRET` to WAHA's HMAC webhook configuration.
- Configure bounded webhook retries so a temporary control API restart does not lose events.
- Do not print or log either secret, webhook bodies, raw QR payloads, or full scheduled-message bodies.

## 3. Make the Control API Own WhatsApp Integration

- Rename the Compose service from `cli-api` to `control-api`.
- Change its internal listen port and loopback host mapping to `8000`.
- Keep the source package under `services/cli-api` to avoid an unrelated package/folder rename.
- Mount the WhatsApp SQLite runtime into `control-api` separately from its Calendar runtime.
- Add a focused WAHA HTTP client using Node.js built-in `fetch`.
- Send text messages with:

  ```text
  POST http://waha:3000/api/sendText
  X-Api-Key: <WAHA_API_KEY>
  Content-Type: application/json
  ```

  ```json
  {
    "session": "default",
    "chatId": "972XXXXXXXXX@c.us",
    "text": "..."
  }
  ```

- Bound sends and lifecycle/read calls separately, cap each configured timeout, enforce one finite overall startup reconciliation deadline, and sanitize downstream errors.
- Preserve the intent of the current uncommitted WhatsApp send-timeout changes through bounded HTTP requests rather than browser/Puppeteer timeout handling.

## 4. Create and Restore the Default Session

- On control API startup, wait for WAHA and list `GET /api/sessions?all=true` so reconciliation also sees unexpected sessions.
- The observed pinned `gows-2026.7.1` list entry was `{ "name": "default", "status": "FAILED", "config": null, "presence": null, "timestamps": {} }`, with no engine metadata. When the listed `default` lacks engine, fetch `GET /api/sessions/default` through the same bounded, API-key-authenticated client. Its live detail field was `{ "engine": { "grpc": { "client": "READY", "stream": "READY" }, "gows": { "found": true, "connected": false } } }`, not an `engine.engine` string. Identify GOWS from the presence of `engine.gows` while retaining string and nested `engine.engine` parsing for other supported response forms.
- Do not fetch detail merely because another session lacks engine, and do not replace list-based reconciliation with detail-only lookup.
- Create and start `default` when it does not exist.
- Explicitly configure WAHA to restore `default` after container restart.
- Confirm the resolved session engine is `GOWS`; treat missing metadata or any other engine as a configuration failure rather than inferring the configured default.
- Do not automatically delete unexpected sessions. Report unexpected active sessions as unhealthy so runtime data is not destroyed implicitly.
- Gate contact synchronization and scheduled sends on session status `WORKING`.
- Store the latest session status from both direct API reconciliation and `session.status` webhooks.

## 5. Replace Auth, Sync, Logout, and Status Flows

- Preserve `dagent services init|auth|sync|logout|status whatsapp` as remote control API commands.
- Replace LocalAuth/browser initialization with WAHA session APIs.
- Fetch QR data through WAHA's documented QR endpoint and return terminal QR art to the CLI without exposing the raw QR payload.
- Map WAHA `WORKING` to completed authorization and `FAILED` to failed authorization.
- Replace contact synchronization with GOWS-compatible WAHA contact/chat endpoints.
- Preserve exact cached display-name resolution and existing `@c.us`/`@g.us` recipient IDs.
- Replace browser-profile, PID, and browser-readiness status fields with WAHA session status, engine, webhook processor health, contact counts, and scheduled-message counts.
- Remove `dagent services start whatsapp` and `dagent services stop whatsapp` because Compose owns the only WhatsApp runtime.
- Remove the native `WHATSAPP_ENABLED` worker startup effect and its supervisor wiring.

## 6. Implement Secure Webhook Ingestion

- Add `POST /internal/whatsapp/webhook` before normal bearer-token route authorization.
- Authenticate this route only with its dedicated WAHA HMAC validation.
- Read the request body as raw `Buffer` chunks with a strict byte limit.
- Compute HMAC-SHA512 over the exact raw body bytes with `WAHA_WEBHOOK_SECRET`.
- Decode `X-Webhook-Hmac` as hex, verify its length, and compare it using `timingSafeEqual`.
- Validate the event envelope before acceptance:
  - Require a non-empty event `id`.
  - Require session `default`.
  - Require one of the five configured event types.
- Insert the event into SQLite using event ID as a unique key.
- Return `200` for newly accepted and duplicate valid events.
- Return `401` for missing or invalid signatures and `400` for malformed signed payloads.
- End the HTTP response after authentication, validation, and durable insertion, before executing business handlers.

## 7. Process Webhooks Durably and Asynchronously

- Add a SQLite webhook inbox with `pending`, `processing`, `processed`, and `failed` states.
- Store event ID, type, session, receive timestamp, processing timestamps, attempts, last error, and the signed payload required for processing.
- Use atomic conditional updates to claim events.
- Recover pending and interrupted processing rows after `control-api` restart.
- Use a bounded retry policy for handler failures.
- Process each event idempotently:
  - `session.status`: upsert the latest WAHA session status and status timestamp.
  - `message`: upsert normalized message identity, direction, chat, sender, timestamp, body, and media-presence metadata.
  - `message.ack`: update acknowledgement code/name and correlate outgoing messages with scheduled sends.
  - `message.edited`: update the normalized message body and edit metadata.
  - `message.revoked`: mark the referenced normalized message revoked.
- Do not persist WAHA engine `_data` or downloaded media.
- Clear the raw inbox payload after successful normalization while retaining the event ID deduplication record.
- Await active processing during graceful control API shutdown before closing SQLite.

## 8. Move Scheduled Sending into the Control API

- Move the due-message polling loop from the deleted worker into `control-api`.
- Preserve the existing behavior:
  - Recover interrupted `sending` rows at startup.
  - Query due `pending` rows in bounded batches.
  - Prevent overlapping loops.
  - Atomically claim `pending` rows as `sending`.
  - Continue processing after an individual send failure.
  - Preserve one-shot and recurring schedule advancement.
- Before each batch, require `default` to be `WORKING`.
- Call WAHA `/api/sendText` with the exact session, chat ID, and text payload.
- Store the returned WAHA message ID on the scheduled-message row.
- Mark the scheduled occurrence sent after a successful WAHA HTTP response.
- Track later server/device/read acknowledgement from `message.ack` without changing the existing schedule recurrence semantics.
- Preserve private-message logging rules: log IDs and timestamps, not message bodies or recipient names.

## 9. Remove the Browser Implementation

- Delete the browser client implementation, detached worker, worker entrypoint, app-service worker, and container worker/control service.
- Remove WhatsApp worker startup from the Telegram/native supervisor.
- Remove Chromium lock cleanup and browser executable health checks.
- Remove LocalAuth session deletion and stored-browser-profile detection.
- Remove Puppeteer executable paths, launch args, no-sandbox flags, and protocol timeout configuration.
- Strip Chrome installation and Puppeteer download variables from the WhatsApp Dockerfile. Keep that image for the database-only WhatsApp MCP server.
- Remove the old `browser-profile` Compose mount without deleting existing host data.
- Remove `whatsapp-web.js`, Puppeteer, Chromium-related transitive dependencies, and browser-specific type packages from root, CLI, and WhatsApp manifests and lockfiles.
- Remove browser QR, browser lock, Puppeteer option, and browser error-classification tests.
- Keep `qrcode-terminal` only in the package that renders WAHA QR data into safe terminal art.

## 10. Tests

Add or update automated tests for:

- Exact WAHA `/api/sendText` URL, API-key header, content type, session, chat ID, and text payload.
- WAHA request timeout, non-2xx response, malformed response, and returned message ID handling.
- Pinned list responses without engine trigger one authenticated default-detail lookup and parse the observed `engine.gows` discriminator while retaining string and nested `engine.engine` support.
- Idempotent `default` session creation/start, GOWS engine enforcement, and unexpected-session detection.
- Missing engine metadata remains a GOWS enforcement failure after response enrichment.
- QR polling, `WORKING` completion, logout, status, and contact synchronization.
- Exact raw-body HMAC validation, including valid, invalid, missing, malformed, and wrong-length signatures.
- Signed malformed JSON and request body size limits.
- Duplicate and concurrent webhook delivery by event ID.
- Immediate HTTP acknowledgement before delayed asynchronous handling.
- Webhook inbox processing, retry, interrupted-processing recovery, and payload cleanup.
- Normalized message, acknowledgement, edit, revoke, and session status updates.
- Scheduled send gating on `WORKING`, atomic claims, timeout/error handling, recurrence, WAHA message ID storage, and acknowledgement correlation.
- Compose image pin, sessions mount, disabled UIs, no WAHA host port, fallback credentials, `control-api:8000`, and no old worker.
- Compose parsing and local startup can use deterministic defaults; production overrides remain required.
- Dependency locks contain no `whatsapp-web.js`, Puppeteer, or Puppeteer browser packages after cleanup.

## 11. Documentation and Configuration

- Update `.env.example` with `WAHA_API_KEY`, `WAHA_WEBHOOK_SECRET`, and `WAHA_BASE_URL=http://waha:3000` without real secret values.
- Update README setup to use the control API on `http://127.0.0.1:8000`.
- Document that existing runtime CLI API configuration pointing to port `7331` must be changed to port `8000`.
- Document the new one-time GOWS pairing flow and the inability to migrate `whatsapp-web.js` LocalAuth data.
- Update `instruction/project.md`, `instruction/whatsapp.md`, `instruction/dagent-api.md`, container documentation, service dependency documentation, runtime layout documentation, and CLI documentation.
- Remove obsolete browser, worker PID, LocalAuth, and Chromium guidance.

## 12. Static Verification

Run the repository checks without starting live services:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run build:cli-api
npm run build:whatsapp
```

Inspect the rendered Compose configuration and confirm:

- WAHA uses the pinned GOWS image.
- WAHA has no host `ports` mapping.
- `/app/.sessions` is persistent.
- Swagger and dashboard are disabled.
- The webhook target is `http://control-api:8000/internal/whatsapp/webhook`.
- `waha` and `control-api` use optional `${HOME}/.local/share/dagent/data/whatsapp/.env` service env files.
- Both services receive the same explicit fallback or production override values.
- Global Compose parsing succeeds without operator-provided secrets.
- No old browser worker service or browser-profile mount remains.

Run the isolation checks without starting services:

```sh
env -u WAHA_API_KEY -u WAHA_WEBHOOK_SECRET docker compose config
env -u WAHA_API_KEY -u WAHA_WEBHOOK_SECRET docker compose build telegram
npm run build && node --test test/opencodeRuntimeConfig.test.mjs
git diff --check
```

## 13. Cutover and Live Verification

Live verification uses the operator's WhatsApp account and must be performed only with explicit approval for container startup and pairing side effects.

1. Stop every existing native supervisor, detached WhatsApp worker, and `whatsapp-worker` container before deploying WAHA.
2. Back up the WhatsApp SQLite database and leave the old browser profile untouched.
3. Inspect any `sending` scheduled rows before resetting them; a prior browser send may have succeeded externally before its database update.
4. Start WAHA, `control-api`, and `whatsapp-mcp` with real secrets configured.
5. Run the control-API-backed WhatsApp auth command and pair the new `default` GOWS session by QR.
6. Confirm `GET /api/sessions/default` has status `WORKING` and an `engine.gows` object that the control API resolves to `GOWS`; do not expect the live response to contain `engine.engine`.
7. Synchronize contacts and confirm existing scheduled recipient IDs remain valid.
8. Restart only the WAHA container.
9. Poll session status and verify `default` returns to `WORKING` without another QR scan.
10. Confirm Docker publishes no WAHA port `3000` and no old worker process/container is active.
11. Trigger or observe a real subscribed event and verify its event ID is stored and processed once.
12. Perform a real scheduled send only with separate explicit approval, then verify WAHA message ID and acknowledgement correlation.

## Acceptance Criteria

- Exactly one Compose WAHA instance owns session `default`.
- WAHA uses browserless GOWS and restores the authenticated session from `/app/.sessions` after restart.
- WAHA port `3000`, Swagger, and dashboard are unavailable from the production host.
- The control API sends through authenticated `/api/sendText` requests with the required payload.
- Webhook signatures are checked against exact raw bytes with HMAC-SHA512.
- Valid webhooks receive `200` after durable deduplication and before asynchronous processing.
- Duplicate event IDs do not repeat lifecycle updates.
- Session, message, acknowledgement, edit, and revoke state survive control API restarts.
- No Chromium, Puppeteer, `whatsapp-web.js`, browser lock, browser health check, LocalAuth, or browser worker code remains.
- The authenticated `default` session returns to `WORKING` after a WAHA container restart.

As of the approved 2026-07-22 remediation, 82 tests, typecheck/builds, targeted images, Compose checks, canonical DB reconciliation/integrity, seven-service recreation, WAHA container health, and no-host-port behavior were verified. The persisted session nevertheless transitioned to `FAILED`; QR re-pairing, real send/webhook traffic, and restart-to-`WORKING` restoration remain unresolved. Do not mark the authenticated-session acceptance criteria complete.

## Child Instructions

| Instruction File | Description |
| --- | --- |
