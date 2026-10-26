# Google Calendar Cache And MCP Instructions

## Scope

This file covers the implemented Google Calendar SQLite cache, OAuth flow, `dagent services ... calendar` CLI commands, optional app service, local stdio MCP server, and container HTTP MCP server for Personal Agent. The MCP server exposes cached read tools, live free/busy lookup, and confirmation-gated event create/update tools.

## Context

Google Calendar support is opt-in and separate from the default Telegram-to-opencode path. The bot does not perform OAuth during normal startup. Calendar authorization, foreground sync, status checks, and MCP serving run through the compiled CLI entry point `cli/src/cli.ts`, exposed by `package.json` as `dagent` and `DAgent` after `npm run build` and `npm link`. Lowercase `dagent` is preferred in current documentation.

Calendar runtime files belong in the selected live folder. CLI selection precedence is `--runtime-directory`/`-r`, `DAGENT_RUNTIME_DIRECTORY`, persistent user config, then invocation cwd. Zsh completion generation is a general CLI helper that documents the Calendar service actions and options.

Important files:

- `cli/src/cli.ts` dispatches `dagent services auth|sync|status|mcp calendar`, `dagent services init`, and `dagent completion zsh`.
- `shared/utils/runtimeDirectory.ts` provides the runtime-directory resolver and service data directory helpers used for Calendar DB and credentials paths.
- `shared/utils/serviceSettings.ts` maps service name `calendar` to `GOOGLE_CALENDAR_ENABLED`.
- `services/calendar/src/google/config.ts` loads Google Calendar environment variables from the runtime-directory `.env` file.
- `services/calendar/src/google/credentials.ts` resolves OAuth client credentials from explicit config first, then the selected SQLite database.
- `services/calendar/src/google/oauth.ts` builds Google auth URLs with optional OAuth `state`, exchanges auth codes, performs local browser OAuth with a temporary localhost callback, and stores the refresh token plus the OAuth client credentials used for the successful authorization.
- `services/calendar/src/google/repository.ts` owns the SQLite schema, local secret persistence, cache persistence, query helpers, and status output.
- `services/calendar/src/google/sync.ts` performs calendar-list sync, per-calendar full sync, incremental sync, window-change recovery, and 410 sync-token recovery.
- `services/calendar/src/google/calendarError.ts` detects nested OAuth `invalid_grant` failures, builds runtime-specific reauthorization guidance, and safely formats Calendar errors.
- `services/calendar/src/google/time.ts` contains local-date and timezone helpers for cache queries.
- `services/calendar/src/googleCalendarCacheService.ts` runs periodic background sync through the app-service lifecycle when `GOOGLE_CALENDAR_ENABLED=true`.
- `services/calendar/src/workerIndex.ts` is the Calendar container foreground worker entry point.
- `services/calendar/src/mcp/googleCalendarMcpServer.ts` exposes cached read tools, live free/busy lookup, and dry-run-by-default event create/update tools over MCP stdio or stateless streamable HTTP.
- `services/calendar/src/mcp/httpIndex.ts` is the Calendar container HTTP MCP entry point used by the standard compose `calendar-mcp` service.
- `services/agent/src/opencode/runtimeConfig.ts` installs runtime `opencode.json` MCP entries; Calendar auth installs the Calendar entry, and `services init` installs both Calendar and WhatsApp entries.
- `test/googleCalendarCacheService.test.mjs` covers cache-service shutdown, OAuth failure detection and redaction, and sync suspension after `invalid_grant`.
- `test/googleCalendarMcpServer.test.mjs` covers pure Calendar MCP helper behavior through compiled output.
- `test/googleCalendarCredentials.test.mjs` verifies SQLite credential fallback and explicit credential precedence through compiled output.
- `<runtimeDirectory>/opencode.json` registers a local MCP server named `calendar` using `dagent services mcp calendar` and `environment.DAGENT_RUNTIME_DIRECTORY` by default; with `DAGENT_CALENDAR_MCP_TRANSPORT=remote`, it registers a remote entry such as `http://calendar-mcp:7332/mcp` instead.

Configuration:

- `GOOGLE_CALENDAR_ENABLED` defaults to `false`. Only set it to `true`, or run `dagent --runtime-directory <live-folder> services enable calendar`, when credentials and a stored refresh token are available; otherwise app startup should not include the Calendar background cache service.
- `GOOGLE_CALENDAR_CLIENT_ID` and `GOOGLE_CALENDAR_CLIENT_SECRET` are required for the initial `auth` unless OAuth client credentials are loaded from a Google Cloud `credentials.json` file. After successful auth, later CLI commands, MCP serving, live MCP tools, and opt-in background sync can fall back to OAuth client credentials persisted in SQLite.
- `GOOGLE_CALENDAR_CREDENTIALS_PATH` optionally points to a downloaded Google OAuth client JSON file. The loader supports `installed.client_id`/`client_secret` and `web.client_id`/`client_secret`; relative paths resolve from the selected Personal Agent runtime directory, and the client ID/secret are persisted to SQLite after successful auth.
- `GOOGLE_CALENDAR_DB_PATH` defaults to `<runtimeDirectory>/data/google-calendar/google-calendar.sqlite`. Explicit absolute overrides are supported; relative overrides resolve from the selected Personal Agent runtime directory. The repository creates the parent directory, resolves the path, enables WAL mode, and stores OAuth tokens, OAuth client credentials, and cache data there.
- `GOOGLE_CALENDAR_SYNC_PAST_DAYS` defaults to `30` and `GOOGLE_CALENDAR_SYNC_FUTURE_DAYS` defaults to `90`.
- `GOOGLE_CALENDAR_SYNC_INTERVAL_SECONDS` defaults to `60` for the background service and must be positive.
- `GOOGLE_CALENDAR_AUTH_REDIRECT_PORT` defaults to `0`, allowing the OS to choose a free `127.0.0.1` callback port ending in `/oauth2callback`.
- `DAGENT_CALENDAR_MCP_TRANSPORT` controls generated opencode Calendar MCP config and defaults to local stdio when unset or `local`; set it to `remote` only with `DAGENT_CALENDAR_MCP_REMOTE_URL` configured.
- `DAGENT_CALENDAR_MCP_REMOTE_URL` is required when `DAGENT_CALENDAR_MCP_TRANSPORT=remote`; standard compose sets it to `http://calendar-mcp:7332/mcp` so opencode in the agent container reaches the Calendar MCP container through Docker DNS.
- `DAGENT_CALENDAR_MCP_HOSTNAME`, `DAGENT_CALENDAR_MCP_PORT`, and `DAGENT_CALENDAR_MCP_PATH` configure the HTTP MCP server entry point in `services/calendar/src/mcp/httpIndex.ts`; standard compose uses `0.0.0.0`, `7332`, and `/mcp` inside the compose network.
- Standard Compose mounts only host `data/google-calendar` at `/runtime/data/google-calendar`; its optional env file is in that host directory. Container worker, MCP, and control-api load direct env credentials or persisted SQLite credentials and intentionally do not dereference host credentials-file paths inside containers.
- Google OAuth currently requests `calendar.readonly`, `calendar.events`, and `userinfo.email`. Operators with tokens created before the `calendar.events` scope was added must run `dagent services auth calendar` again, and may need to revoke the old app grant first if Google does not return a new refresh token.

SQLite tables are created with `CREATE TABLE IF NOT EXISTS`:

- `google_oauth_tokens` stores the single account refresh token, optional access token, expiry, scope, token type, account email, and update timestamp.
- `google_oauth_client_credentials` stores one OAuth client ID/secret pair and update timestamp. Treat this table as a local secret store.
- `calendars` stores Google calendar metadata, colors, hidden/selected flags, etag, raw JSON, and update timestamp.
- `calendar_sync_state` stores per-calendar sync tokens, configured sync window values, last full/incremental/success/attempt timestamps, and last error.
- `events` stores event identity, status, summary, description, location, link, timed start/end strings and UTC milliseconds, all-day date ranges, recurrence/organizer/creator/attendee JSON, etag, Google update timestamp, deletion flag, raw JSON, and update timestamp.

Repository indexes support `(calendar_id, event_id)` lookup, timed range queries, all-day date overlap, and active/deleted filtering by calendar.

## Rules

- Keep Calendar support disabled by default; do not require Google credentials for ordinary Telegram/opencode operation.
- Keep OAuth in `dagent services auth calendar`; do not start a browser or consent flow from Telegram polling or app startup.
- Treat runtime `data/` and `GOOGLE_CALENDAR_DB_PATH` contents as local generated data containing secrets; never commit the SQLite database, WAL, SHM, copied token values, client IDs, or client secrets.
- Keep the default Calendar SQLite path under `<runtimeDirectory>/data/google-calendar/`.
- Keep Calendar DB and credentials path resolution tied to the selected runtime directory after selection; opencode may launch the MCP server from a different cwd.
- Preserve the OAuth scopes `https://www.googleapis.com/auth/calendar.readonly`, `https://www.googleapis.com/auth/calendar.events`, and `https://www.googleapis.com/auth/userinfo.email` unless a reviewed Calendar capability requires a change.
- Store a refresh token locally and require `prompt=consent`; if Google does not return a refresh token, tell the user to revoke the grant and authorize again.
- After successful `dagent services auth calendar`, persist the OAuth client ID/secret used for that auth in `google_oauth_client_credentials` so later Calendar CLI invocations, including opencode-launched `mcp`, can fall back to SQLite without requiring env credentials or a credentials file again.
- Preserve credential precedence for `auth`, `sync`, and `status`: CLI `-f`/`--credentials-file` wins, then explicit env client ID/secret, then `GOOGLE_CALENDAR_CREDENTIALS_PATH`, then persisted SQLite client credentials. Preserve `mcp` behavior separately: ignore `-f`/`--credentials-file`, load env client ID/secret when present, and otherwise fall back to persisted SQLite client credentials. Preserve background sync behavior separately: use the startup config from env or `GOOGLE_CALENDAR_CREDENTIALS_PATH` when present, then resolve persisted SQLite client credentials before each sync run.
- In cli-api-mediated `auth`, preserve the same local `-f` UX but do not send the path to the API. The host-native CLI must read and parse the Google credentials JSON locally, upload only OAuth client credentials, and let the API store those credentials after the callback succeeds.
- In cli-api-mediated `auth`, keep the API redirect URI stable at `/calendar/auth/callback` and carry the auth session id in OAuth `state`, not in a dynamic callback path. Google rejects callback paths that are not exactly listed as authorized redirect URIs.
- For API-mediated `auth`, configure redirect URIs to the deployed origin plus `/calendar/auth/callback`; standard Compose uses `http://localhost:8000/calendar/auth/callback` or `http://127.0.0.1:8000/calendar/auth/callback`.
- Do not expose OAuth client IDs, client secrets, access tokens, or refresh tokens in `status` output, MCP tool output, logs, errors, README examples, or instruction prose. Status may report only non-secret configured/present booleans, account email, timestamps, DB path, and credentials file path.
- Route sync, worker, MCP, and control-api errors through `safeCalendarErrorMessage()`: redact bearer/query/JSON/key-value credential forms, truncate messages, and never log raw Gaxios objects.
- Keep background and foreground sync read-only; sync must not create, update, delete, or RSVP to calendar events.
- Keep background cache sync non-overlapping; a running initial or interval sync should make later interval ticks no-op until it finishes.
- Treat Google OAuth `invalid_grant` at the cache-service boundary as expired or revoked authorization. Detection must handle nested Gaxios response/data fields and causal error objects without dumping those objects.
- On the first `invalid_grant`, log one concise secret-safe instruction using the service's selected runtime directory: `dagent --runtime-directory <runtimeDirectory> services auth calendar`. Clear the sync interval and suppress later sync attempts for that service instance, but keep the worker process alive for `SIGINT`/`SIGTERM` so container supervision does not create restart churn.
- Never launch OAuth automatically after `invalid_grant`. Reauthorization is an explicit operator action, and a subsequent service/container restart may retry sync using the newly stored grant.
- Keep non-auth sync failures retryable on later interval ticks. Log only a safely formatted message, not raw Gaxios/error objects; redact bearer values and OAuth token/client credential values in query strings or JSON-shaped messages.
- Safely format uncaught Calendar worker startup failures before writing them to stderr; never pass a raw error object to `console.error` at this boundary.
- In `GoogleCalendarCacheService.stop()`, always await any in-flight sync before closing `GoogleCalendarRepository`, including during `runApp()` startup unwind after another service fails.
- Suppress initial/background sync error logging after Calendar shutdown starts, but keep logging sync failures while the service is running.
- Keep MCP mutation safety explicit: `calendar_create_event` and `calendar_update_event` must dry-run by default, return a preview with `requiresConfirmation: true`, and call Google Calendar only when `confirm: true` is supplied.
- Keep `sendUpdates` defaulting to `none` for mutating MCP tools. Only pass `all` or `externalOnly` when the caller explicitly requests it.
- Do not add Calendar delete, RSVP, attendee response, or broad write tools without a new explicit user request and a reviewed confirmation design.
- Mutating MCP tools may use live Google Calendar APIs and should upsert the returned event into the local cache only when the target calendar is present in the cache.
- `calendar_find_free_time` uses the live Google Calendar freebusy API, not only the SQLite cache; keep it non-mutating and include per-calendar freebusy errors in output.
- Full sync uses `events.list` with `singleEvents=true`, `showDeleted=true`, `timeMin`, `timeMax`, and the configured 30/90-day default window.
- Incremental sync uses the stored per-calendar `syncToken` and does not send `timeMin` or `timeMax` with the incremental request.
- If the configured sync window differs from stored per-calendar state, clear that calendar's cached events and sync state before a full resync.
- If Google returns HTTP 410 for a sync token, clear that calendar's cached events and sync state before a full resync.
- Track per-calendar sync errors in `calendar_sync_state.last_error`; one failing calendar should not hide other calendar statuses.
- Preserve all-day events as exclusive `[start_date, end_date)` date ranges, not midnight timestamps.
- Preserve timed events with UTC millisecond fields for overlap queries and keep original Google start/end values in raw JSON.
- MCP server stdout is reserved for JSON-RPC protocol messages. Write diagnostics to stderr only.
- For the HTTP Calendar MCP server, keep streamable HTTP stateless: create a fresh `McpServer`, `GoogleCalendarRepository`, and `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` for each POST request, then close all three after the response. Do not reuse one stateless transport or MCP server across requests; the MCP SDK expects a fresh stateless transport per request and reuse can cause HTTP 500 failures after agent calls.
- Preserve HTTP MCP routing behavior: `GET /health` returns health JSON, POSTs to the configured MCP path handle JSON-RPC, non-POST requests to that path return a JSON-RPC 405 error, and path mismatches return 404.
- Preserve local/non-container Calendar MCP as stdio by default. Do not require the HTTP MCP transport unless `DAGENT_CALENDAR_MCP_TRANSPORT=remote` or the standard compose `calendar-mcp` service is being used.
- Keep the standard compose remote Calendar MCP URL on the compose service DNS name `calendar-mcp`, not localhost; from inside the agent container, `localhost` would refer to the agent container itself.
- Keep `googleCalendarMcpServerTestHooks` limited to deterministic pure helpers. Unit tests must not start the MCP stdio server, run OAuth, call live Google APIs, or read runtime secrets.
- Keep README and CLI help/completion descriptions aligned with the current MCP tool set; do not describe the Calendar MCP server as read-only.
- Restart opencode after changing `opencode.json`, rebuilding, or relinking `dagent`; opencode reads local MCP configuration at startup.
- Preserve Calendar MCP installation after successful `dagent services auth calendar`; auth should remind the operator to restart opencode.
- Keep the removed top-level `google-calendar` command group removed unless compatibility is explicitly requested.

## CLI Commands

Run `npm run build` before invoking compiled CLI commands. Use `npm link` when opencode must launch `dagent` globally.

```sh
dagent --runtime-directory <live-folder> services init
dagent --runtime-directory <live-folder> services auth calendar [-f <credentials.json>]
dagent --runtime-directory <live-folder> services sync calendar [-f <credentials.json>]
dagent --runtime-directory <live-folder> services status calendar [-f <credentials.json>]
dagent --runtime-directory <live-folder> services mcp calendar
dagent completion zsh
```

If the shell is already in the desired live folder, the `--runtime-directory <live-folder>` option can be omitted only when env and persistent defaults do not select another runtime. `DAGENT_RUNTIME_DIRECTORY=<live-folder>` is supported, and the explicit CLI option wins over environment and persistent configuration.

- `dagent services init` creates runtime data, initializes Calendar and WhatsApp SQLite/MCP state, and exits without starting Telegram, opencode, OAuth, WAHA, or live sync.
- `dagent services status calendar`, `services enable calendar`, and `services disable calendar` inspect or persist `GOOGLE_CALENDAR_ENABLED` in the selected runtime `.settings`; runtime `.env` and process env remain higher-precedence overrides, and these commands do not run OAuth, sync, or the app.
- `services auth calendar` opens the browser, listens on `127.0.0.1:<port>/oauth2callback`, exchanges the authorization code, reads the Google account email, stores both the token and OAuth client ID/secret in SQLite, installs or updates the runtime `opencode.json` Calendar MCP entry, and prints a restart-opencode reminder.
- In cli-api-mediated mode, `services auth calendar` does not use the local browser-listener flow. It accepts the same `-f <credentials.json>` option, but that path is resolved and read by the host-native CLI using the selected local runtime-directory rules; the CLI sends only `{ clientId, clientSecret }` in `POST /calendar/auth/start`. The API creates an auth URL whose redirect URI is the stable API callback `/calendar/auth/callback` and whose OAuth `state` is the session id. The CLI then prints the returned Google auth URL, waits by polling `GET /calendar/auth/sessions/:id`, and reports the `opencode.json` path after the API callback reads `state`, stores the token/client credentials in the API/Calendar runtime, and installs Calendar MCP config in the configured opencode runtime (`DAGENT_AGENT_RUNTIME_DIRECTORY` when set, otherwise the API runtime). If the session includes `restart.status: "restarted"`, the CLI reports that the agent container was restarted; if restart is skipped or fails, the CLI still reports auth success and prints the non-secret restart message so the operator can restart opencode manually. The API/container must not try to open the original credentials-file path.
- In cli-api-mediated mode, `services status calendar` calls `GET /calendar/status`, and `services sync calendar` calls `POST /calendar/sync`. Remote sync accepts no credentials-file option and uses credentials already stored by auth.
- `services sync calendar` runs one foreground sync and prints a JSON result with calendars seen, calendars synced, and per-calendar errors.
- `services status calendar` prints JSON with the resolved DB path, non-secret credentials status, token presence and account email when known, sync window, calendar count, event count, and sync states.
- `services mcp calendar` starts the local stdio MCP server and must be launched by an MCP client or opencode, not as a normal interactive status command. The container HTTP MCP server is a separate entry point, `node dist/services/calendar/src/mcp/httpIndex.js`, for compose deployments where opencode connects to a remote MCP URL.

`auth`, `sync`, and `status` accept `-f <path>` or `--credentials-file <path>` to load OAuth client credentials from a Google Cloud credentials JSON file. Relative CLI credential paths resolve from the selected Personal Agent runtime directory, not the invoking shell's cwd unless cwd is the selected runtime; use an absolute path when the file lives elsewhere. The CLI path overrides `GOOGLE_CALENDAR_CREDENTIALS_PATH` and `GOOGLE_CALENDAR_CLIENT_ID`/`GOOGLE_CALENDAR_CLIENT_SECRET` for that invocation. Without `-f`, explicit env client ID/secret values take precedence over `GOOGLE_CALENDAR_CREDENTIALS_PATH`. If no current CLI/env credentials resolve, these commands fall back to the OAuth client ID/secret persisted in SQLite by the last successful auth. `status` should report `credentials.configured: true` when credentials resolve from any source, including SQLite, but must not print the actual client ID or secret.

For remote `auth`, only auth uses the credential upload path. Remote `status` and `sync` use their dedicated endpoints and credentials already persisted in the Calendar database. The uploaded auth body is intentionally just OAuth client ID/secret, never the full credentials JSON, token values, or local path string.

`mcp` also resolves stored OAuth client credentials before starting the stdio server. It ignores a credentials-file flag and does not load `GOOGLE_CALENDAR_CREDENTIALS_PATH`, but it may use explicit env client ID/secret values; if they are absent, it falls back to the client ID/secret persisted by `dagent services auth calendar`. The container HTTP MCP entry point (`services/calendar/src/mcp/httpIndex.ts`) loads its base config with `loadCredentials: false`, opens the selected Calendar SQLite repository, resolves persisted OAuth client credentials from that repository when env client ID/secret values are absent, closes it, and only then starts the HTTP MCP server. This lets the standard compose `calendar-mcp` service run without credential env variables or credential files while still using the OAuth client credentials saved by auth. This is required because live MCP tools such as free/busy lookup and confirmed event create/update construct a Google OAuth client from the stored refresh token plus OAuth client credentials, and opencode may launch MCP without credential env variables or a credentials file.

`dagent services init` and successful `dagent services auth calendar` call the opencode runtime config installer. `services init` installs both default MCP entries, while Calendar auth installs or repairs the Calendar entry. CLI API mediated Calendar auth may then restart the agent container when a restart command is configured by env or safe default and the installed config path exactly equals the configured agent opencode config path; mismatches, missing config, and restart command failures must not undo token storage. The default local Calendar config shape in `<runtimeDirectory>/opencode.json` is:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "calendar": {
      "type": "local",
      "command": ["dagent", "services", "mcp", "calendar"],
      "environment": {
        "DAGENT_RUNTIME_DIRECTORY": "<runtimeDirectory>"
      },
      "enabled": true
    }
  }
}
```

The installer preserves unrelated top-level fields and unrelated `mcp` entries, forces `$schema` to `https://opencode.ai/config.json`, and errors if an existing `mcp` field is not a JSON object. The generated `environment.DAGENT_RUNTIME_DIRECTORY` value must be the selected runtime directory for local entries so opencode-launched MCP processes use the right `.env` and SQLite database regardless of cwd. Do not remove or overwrite the WhatsApp MCP entry when changing Calendar-only installer behavior. Restart opencode after init/auth, rebuilding, relinking, or changing this config so opencode reloads the MCP definition and can find `dagent` on PATH.

When `DAGENT_CALENDAR_MCP_TRANSPORT=remote`, the Calendar entry instead has shape `{ "type": "remote", "url": "<DAGENT_CALENDAR_MCP_REMOTE_URL>", "enabled": true }` and does not include a local command or `DAGENT_RUNTIME_DIRECTORY` environment. In standard Compose, CLI API writes that remote entry to `/agent-runtime/opencode.json`, backed by root `${HOME}/.local/share/dagent/opencode.json`, while `calendar-mcp` reads tokens and SQLite state from `/runtime/data/google-calendar`, backed by host `data/google-calendar`.

Background app sync through `GoogleCalendarCacheService` receives the config loaded in `services/telegram/src/app.ts`, initializes the selected SQLite repository, then calls `resolveStoredGoogleOAuthCredentials()` before each sync run. This lets `GOOGLE_CALENDAR_ENABLED=true` use the OAuth client ID/secret saved by `dagent services auth calendar` even when `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`, and `GOOGLE_CALENDAR_CREDENTIALS_PATH` are no longer present in `.env`; startup must still never prompt for OAuth.

Containerized Calendar sync uses `services/calendar/src/workerIndex.ts`. It selects the runtime with the normal env/persistent/cwd precedence, loads config with credentials-file dereferencing disabled, then lets `GoogleCalendarCacheService` resolve direct env or persisted SQLite credentials. It starts the cache service, waits for `SIGINT`/`SIGTERM`, then stops it. It is a foreground worker for Docker supervision and must not call `dagent start` or start Telegram/opencode/WhatsApp.

`GoogleCalendarCacheService.start()` schedules the interval and kicks off the initial sync without awaiting live Google API work, so Calendar startup can complete before the first sync finishes. The service tracks one `activeSync` promise and skips overlapping initial/background sync attempts. An `invalid_grant` marks authorization invalid for that service instance, clears the interval, emits one reauthorization command for the selected runtime, and leaves the foreground worker waiting for shutdown signals; ordinary failures remain eligible for the next interval retry. `stop()` sets a stopping flag, clears the interval, awaits active sync, and only then closes SQLite. This ordering preserves safe reverse-order unwind after any later native service startup failure. During stopping, initial/background sync errors are swallowed instead of logging noisy follow-on database errors.

`dagent completion zsh` prints a zsh completion script to stdout. The CLI does not modify shell startup files; operators install the generated script manually as documented in `README.md`.

## MCP Tools

The local MCP server opens no network port. The container HTTP MCP server listens on the configured hostname, port, and path, exposes `GET /health` for container health probing, and handles each MCP POST with a new stateless streamable HTTP transport/server/repository instance. Both transports use the same tool implementation and selected Calendar runtime. Cached read tools read directly from SQLite. Free-time and confirmed create/update tools use the stored Google OAuth token and the Google Calendar API. Tool outputs are JSON strings in MCP text content.

- `calendar_list_calendars` lists cached calendars with primary flag, timezone, access role, hidden, and selected status.
- `calendar_view_day` accepts `date`, optional `timeZone`, and optional `calendarIds`; it returns cached events for that local day.
- `calendar_view_range` accepts `startDate`, `endDate`, optional `timeZone`, and optional `calendarIds`; it returns events overlapping `[startDate, endDate)`.
- `calendar_search_events` accepts a text query, optional date range, optional timezone, optional calendar IDs, and an optional limit up to 100.
- `calendar_next_events` returns upcoming cached events from now, with optional timezone, calendar IDs, and limit up to 100.
- `calendar_sync_status` returns the same cache status shape used by the CLI status command.
- `calendar_create_event` previews or creates a Google Calendar event. It requires `summary` plus either timed `startDateTime`/`endDateTime` ISO date-times or all-day `startDate`/`endDate` dates where end date is exclusive. It accepts optional `calendarId`, `description`, `location`, `timeZone`, `attendees`, `sendUpdates`, and `confirm`. Without `confirm: true`, it returns a dry-run preview and must not call Google Calendar.
- `calendar_update_event` previews or patches an existing Google Calendar event. It requires `eventId`, accepts optional `calendarId`, event fields, timed or all-day replacement time fields, `attendees`, `sendUpdates`, and `confirm`, and must receive at least one patch field. Without `confirm: true`, it returns a dry-run preview and must not call Google Calendar.
- `calendar_find_free_time` queries Google Calendar freebusy for candidate slots. It requires `timeMin`, `timeMax`, and `durationMinutes`; accepts optional `calendarIds`, `timeZone`, `workingHours`, `slotIncrementMinutes`, and `limit`; defaults calendars to selected visible cached calendars, then primary, then `primary`; defaults slot increment to `min(durationMinutes, 30)`; and rejects ranges longer than 366 days.

For create/update tools, `calendarId` defaults to the cached primary calendar ID when available, otherwise Google Calendar's `primary` alias. Timed events require both start and end date-times, all-day events require both start and exclusive end dates, and timed/all-day fields must not be mixed. Returned errors must be sanitized so bearer tokens are redacted.

## Verification

Static verification after Calendar code changes:

```sh
npm install
npm test
npm run typecheck
npm run build
docker compose config
node dist/cli/src/cli.js help
node dist/cli/src/cli.js --help
node dist/cli/src/cli.js completion zsh
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services init
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services status calendar
```

The init and status commands should work without Google credentials and should create or open the configured SQLite DB path in the selected runtime directory. A fresh local cache reports no token and zero calendars/events. For runtime-selection checks, run the built CLI from another directory with an absolute path and confirm explicit `--runtime-directory` keeps `runtimeDirectory`, `dbPath`, and `opencodeConfig.configPath` under the selected live folder while `currentDirectory` shows the alternate cwd.

`npm test` runs `npm run build` and then `node --test test/*.test.mjs`. Calendar MCP unit tests import `googleCalendarMcpServerTestHooks` from the compiled `dist/mcp/googleCalendarMcpServer.js` output and should cover pure helper behavior without live Google API calls, OAuth, MCP stdio sessions, startup commands, or runtime secret files. Calendar credential tests import `resolveStoredGoogleOAuthCredentials` and `loadGoogleCalendarHttpMcpConfig` from compiled output and may create temporary SQLite databases with fake credential strings to verify precedence and HTTP MCP SQLite fallback without reading real secrets. Calendar cache service lifecycle tests import compiled output and may monkey-patch `GoogleCalendarSync.prototype.runOnce` to simulate a long initial sync; keep these tests free of live Google API calls and app startup commands.

For Calendar OAuth error handling, retain focused tests that detect nested and causal `invalid_grant`, verify credential-bearing messages are redacted, and prove repeated interval syncs stop after one authorization failure while the service remains stoppable. Also retain a non-auth case when changing retry behavior so ordinary failures continue to retry.

For changes to `GoogleCalendarCacheService.stop()` or initial/background sync supervision, preserve the regression proving stop awaits active sync before SQLite closes. WhatsApp no longer runs later in the native supervisor, but the reverse-order startup-failure invariant remains.

Live verification requires Google Cloud OAuth credentials and user consent:

```sh
dagent --runtime-directory <live-folder> services auth calendar
dagent --runtime-directory <live-folder> services sync calendar
dagent --runtime-directory <live-folder> services status calendar
dagent --runtime-directory <live-folder> services mcp calendar
```

Real OAuth, live Google sync, live freebusy lookup, and confirmed create/update calls require credentials and user consent. Startup commands are intentionally not part of automated Calendar verification unless side effects are approved.

For HTTP MCP transport changes, prefer static and unit verification plus `docker compose config`; do not run live container startup, OAuth, or Google API checks unless explicitly approved. If live HTTP MCP debugging is approved, verify repeated POST requests to the configured `/mcp` path do not share transport/server instances and do not regress to 500s after the first agent request.

The CLI services reorganization was reported verified with `npm run typecheck`, `npm test`, `npm run build`, and safe CLI smoke checks including `services status calendar`. Startup and live OAuth were intentionally not run.

The 2026-07-22 remediation superseded the old container-path status: Calendar SQLite integrity passed at the canonical path, stored credentials were preserved without exposure, cache state was restored, worker and MCP were healthy without credential-file path errors, and the full suite passed 82 tests.

## Child Instructions

| Instruction File | Description |
| --- | --- |
