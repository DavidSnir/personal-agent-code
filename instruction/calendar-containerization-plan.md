# Calendar Containerization Instructions

## Scope

This file captures the implemented container boundary for the Google Calendar service: the background worker, SQLite cache/runtime state, CLI API mediated auth, and Calendar MCP access for the agent.

## Context

Calendar has three distinct responsibilities:

- A background sync worker talks to the Google Calendar API and maintains the local SQLite cache.
- A Calendar MCP server lets the agent read cached calendar data and perform approved live Calendar actions such as event create/update.
- Calendar auth/login can be initiated by the host-native `dagent` CLI through the CLI API when `DAGENT_CLI_API_URL` or runtime CLI API config is set, so OAuth state and tokens are stored in the container runtime volume rather than in an unrelated host runtime.

The Calendar database remains SQLite. Do not create a database container unless the project deliberately migrates Calendar storage to a network database such as Postgres. SQLite state, OAuth tokens, and service runtime files belong in a mounted runtime volume, not in an image layer.

Implemented Calendar-only container shape:

```text
calendar-worker container
  -> Google Calendar API
  -> shared Calendar runtime/SQLite volume

calendar-mcp container
  -> agent/opencode over MCP
  -> shared Calendar runtime/SQLite volume
  -> Google Calendar API for live tools such as free/busy and confirmed create/update

shared runtime volume
  -> data/google-calendar/google-calendar.sqlite
  -> OAuth token/client credential state
  -> generated Calendar runtime config
```

With the existing broader app split, the compose deployment shape is:

```text
agent
telegram
control-api
calendar-worker
calendar-mcp
```

`calendar-worker` and `calendar-mcp` both build `services/calendar/Dockerfile`, load optional `${HOME}/.local/share/dagent/data/google-calendar/.env`, set `DAGENT_RUNTIME_DIRECTORY=/runtime`, and mount only `${HOME}/.local/share/dagent/data/google-calendar:/runtime/data/google-calendar`. The long bind has `create_host_path: false`; initialize it with `services init compose`. `calendar-worker` uses the Dockerfile default command, `node dist/services/calendar/src/workerIndex.js`, which starts `GoogleCalendarCacheService` in the foreground and stops it on `SIGINT` or `SIGTERM`. It does not dereference host credentials-file paths in-container. `calendar-mcp` overrides the command to `node dist/services/calendar/src/mcp/httpIndex.js`, sets `DAGENT_CALENDAR_MCP_HOSTNAME=0.0.0.0`, `DAGENT_CALENDAR_MCP_PORT=7332`, and `DAGENT_CALENDAR_MCP_PATH=/mcp`, shares the same narrow data subtree, and exposes streamable HTTP MCP only on the compose network. The agent reaches it as `http://calendar-mcp:7332/mcp`; do not use localhost from the agent container.

`services/calendar/Dockerfile` uses the nested TypeScript service build pattern. Its build stage copies root `package.json` with root `tsconfig.json` before copying the Calendar package manifest and before running `npm ci --prefix services/calendar`. Keep the root manifest copy even though root dependencies are not installed: TypeScript `module: NodeNext` needs the nearest root package scope with `"type": "module"` while compiling `shared/**` and Calendar source into ESM `dist/**/*.js`. The Dockerfile includes a build-time import assertion for `dist/shared/utils/runtimeDirectory.js` and `getDefaultRuntimeDirectory` to catch compiled module-format regressions before the image is published.

Compose `control-api` remains the app-control/auth boundary while using source package `services/cli-api`. It mounts Calendar at `/runtime/data/google-calendar` and exact agent config at `/agent-runtime/opencode.json`, installs remote Calendar MCP at `http://calendar-mcp:7332/mcp`, and supports host-read credential-file uploads. Dedicated `/calendar/status` and `/calendar/sync` routes avoid broad CLI execution.

## Rules

- Preserve two Calendar containers: `calendar-worker` and `calendar-mcp`.
- Keep the Calendar SQLite database in a mounted runtime volume shared by the worker and MCP containers.
- Do not add a separate database container while Calendar uses SQLite.
- Use a third Calendar-related container only after an explicit storage migration to a network database.
- Keep worker and MCP lifecycles separate: worker restarts should not kill MCP, and MCP restarts should not stop background sync.
- Preserve SQLite WAL mode and repository ownership rules so two Calendar processes can safely share the database.
- Keep OAuth/auth explicit. Normal worker or MCP startup must not initiate browser login.
- Calendar auth/login in containerized mode should be initiated by the host-native CLI through CLI API endpoints, not by running a browser-opening local OAuth flow inside the wrong runtime.
- Keep the Calendar Dockerfile default command pointed at `dist/services/calendar/src/workerIndex.js`, not the Telegram or supervisor entry point.
- Keep `services/calendar/Dockerfile` copying root `package.json` with root `tsconfig.json` before the service package manifest; do not remove it as an apparent unused dependency input.
- Keep standard compose Calendar MCP on the HTTP transport implemented by `services/calendar/src/mcp/httpIndex.ts`; local/non-container MCP remains stdio through `dagent services mcp calendar`.
- Keep Calendar runtime secrets out of images: OAuth refresh tokens, OAuth client secrets, SQLite files, `.env`, `.settings`, logs, and generated runtime data must stay in ignored runtime volumes.
- Keep container credential-file loading disabled; use direct env values or credentials persisted in canonical SQLite.
- Keep all Calendar boundary errors secret-safe and truncated.
- Keep generated standard-compose opencode Calendar MCP config remote, with URL `http://calendar-mcp:7332/mcp`, while keeping generated local/non-container config stdio unless `DAGENT_CALENDAR_MCP_TRANSPORT=remote` is explicitly set.

## Implemented CLI API Auth Flow

Containerized Calendar auth uses this shape when the host-native CLI has a CLI API URL configured:

```text
host dagent services auth calendar
  -> optional -f credentials.json read locally by host CLI
  -> CLI API POST /calendar/auth/start
  -> API returns Google auth URL, stable callback URL, and session id
  -> CLI prints or opens the auth URL
  -> browser completes Google login
  -> Google redirects to API callback endpoint
  -> API exchanges code and stores tokens/client credentials in shared Calendar runtime DB
  -> CLI polls auth session status and reports success
```

This avoids binding the OAuth callback to an unreachable container-local `127.0.0.1` listener and ensures the resulting token is stored in the runtime used by the Calendar worker and MCP server.

The CLI polls `GET /calendar/auth/sessions/:id`. The callback endpoint is public at `GET /calendar/auth/callback` because Google redirects a browser to it; other Calendar auth API endpoints still use normal CLI API bearer authorization when `DAGENT_API_TOKEN` is configured. The API must put the session id in the Google OAuth `state` parameter and read that `state` on callback; do not put the session id in the callback path. Uploaded credentials are in-memory session inputs until the callback succeeds, then the API stores the OAuth token and OAuth client credentials in its selected runtime SQLite DB for the Calendar worker and MCP.

Google Cloud OAuth authorized redirect URIs must exactly match the deployed control API origin plus `/calendar/auth/callback`, such as `http://localhost:8000/calendar/auth/callback` or `http://127.0.0.1:8000/calendar/auth/callback`.

After a successful CLI API Calendar OAuth callback installs the Calendar MCP entry, the API normally restarts the standard compose agent container so opencode reloads `opencode.json`. Standard compose sets `DAGENT_AGENT_RUNTIME_DIRECTORY=/agent-runtime`; when `/var/run/docker.sock` exists, `services/cli-api/src/index.ts` defaults the restart command to `node dist/services/cli-api/src/restartDockerContainer.js dagent-agent`. The restart helper uses the Docker Engine API over the mounted socket.

Preserve the safety gates around this default. Restart only after OAuth/token storage and MCP install succeed, verify the installed config path exactly equals the configured agent opencode config path, and report restart status as non-secret session data. Missing Docker socket access, missing/overridden restart configuration, config-path mismatch, or command failure must not fail OAuth token storage or MCP installation; the CLI should still report auth success and tell the operator whether manual opencode restart is needed. API startup and service enable/disable endpoints must never initiate OAuth or restart the agent.

Mounting the Docker socket in `control-api` gives that container host Docker control. Preserve loopback-only publishing unless the deployment has a trusted boundary, and require `DAGENT_API_TOKEN` for broader exposure.

## Verification

Safe automated checks for Calendar container planning or Docker asset changes should include:

```sh
npm run typecheck
npm test
npm run build
docker compose config
docker compose build calendar-worker calendar-mcp
```

For Calendar image import/export fixes, verify the rebuilt image with non-startup imports such as `/app/dist/shared/utils/runtimeDirectory.js` and `/app/dist/services/calendar/src/google/config.js`. Do not import `workerIndex.js` or `mcp/httpIndex.js` for smoke checks because they start the Calendar worker or HTTP MCP server.

Do not run live OAuth, worker startup, MCP startup, `docker compose up`, or Google API sync during automated verification unless the user explicitly approves the side effects.

The approved 2026-07-22 live remediation verified canonical Calendar DB integrity, preserved credentials without exposure, restored cache data, and healthy worker/MCP operation without configuration-path errors.

## Child Instructions

| Instruction File | Description |
| --- | --- |
