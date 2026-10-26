# Personal Agent

Personal Agent is a Node.js and TypeScript Telegram bot that runs as a small multi-service app. This repository contains the agent logic; choose a live/runtime folder outside this code repository for local `.env`, `.settings`, generated `opencode.json`, SQLite databases, and service data. The app manages a local `opencode serve` process and forwards authorized Telegram chat text to the opencode HTTP API.

## Requirements

- Node.js 20 or newer
- A Telegram bot token from BotFather
- Your numeric Telegram user ID
- A local `opencode` CLI available on your PATH
- Optional Google Cloud OAuth client credentials for Google Calendar cache/MCP support
- Optional Docker Compose and WhatsApp access for WAHA GOWS scheduled messaging

## Setup

1. Install dependencies:

```sh
npm install
```

2. Choose the folder where the agent should live. Create `<live-folder>/.env` from this repository's `.env.example` for environment, secret, or override settings if needed; service preferences are normally written to `<live-folder>/.settings` by `dagent services enable|disable`.

To find your numeric user ID, message your bot once, then open `https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates` in a browser or with `curl` and copy `message.from.id` from your update. Do not use a username for access control.

3. Build and link the CLI:

```sh
npm run build
npm link
```

This exposes the package bins as `dagent` and `DAgent`.

4. Initialize the selected live folder:

```sh
dagent --runtime-directory <live-folder> services init
```

You can also `cd <live-folder>` and run `dagent services init`. Init creates `<live-folder>/data`, service data directories, `<live-folder>/data/google-calendar/google-calendar.sqlite`, `<live-folder>/data/whatsapp/whatsapp.sqlite`, and `<live-folder>/opencode.json` without starting Telegram, opencode, OAuth, WAHA, or live sync.

5. Store Telegram credentials in the selected live folder:

```sh
dagent --runtime-directory <live-folder> services auth telegram --bot-token <token> --user-id <numeric-id>
```

The token is stored locally under `<live-folder>/data/telegram/credentials.json` and is never printed by status commands. `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USER_ID` remain supported as optional `.env` overrides.

6. Run the bot in the background:

```sh
dagent --runtime-directory <live-folder> start
```

`dagent start` launches the compiled app supervisor detached and returns after printing a pid and log path. App stdout/stderr, including forwarded opencode output when enabled, is appended to `<live-folder>/data/dagent/dagent.log` instead of streaming in the invoking terminal. By default enabled services start `opencode serve --port 4096 --hostname 127.0.0.1 --print-logs` from `/Users/davidsnir/ai-projects/personal-agent`, then Telegram long polling. Calendar starts only when enabled; WhatsApp is Compose-only.

Stop the detached supervisor with `dagent --runtime-directory <live-folder> stop`. `npm start` runs in the foreground without CLI argument parsing; if using it from this code repository, set `DAGENT_RUNTIME_DIRECTORY=<live-folder>` so runtime files are read from the live folder instead of the code repository cwd.

## DAgent CLI

Build before invoking the compiled CLI:

```sh
npm run build
```

Useful operator commands:

```sh
dagent help
dagent --runtime-directory <live-folder> services init
dagent --runtime-directory <live-folder> services status telegram
dagent --runtime-directory <live-folder> services list
dagent --runtime-directory <live-folder> services disable telegram
dagent --runtime-directory <live-folder> start
dagent --runtime-directory <live-folder> stop
dagent --runtime-directory <live-folder> services status calendar
dagent --runtime-directory <live-folder> services status whatsapp
dagent completion zsh
```

The runtime directory selection order is explicit `-r`/`--runtime-directory`, then `DAGENT_RUNTIME_DIRECTORY`, then the persistent configured default, then the current working directory. Set or inspect the persistent default with `dagent config runtime-directory --path /absolute/live-folder` and `dagent config runtime-directory`; clear it with `dagent config runtime-directory --clear`. This local command stores runtime-independent user configuration at `${XDG_CONFIG_HOME:-$HOME/.config}/dagent/config.json`; it does not contact the CLI API, migrate data, or create the selected runtime directory. Runtime `.env`, `.settings`, relative `DOTENV_CONFIG_PATH`, Telegram credentials, Google Calendar credentials, generated `opencode.json`, and default service DB paths resolve from the selected runtime directory.

When a CLI API URL is configured, list/status/enable/disable/init and service-specific operations use dedicated HTTP endpoints. The broad `/cli` subprocess proxy is disabled. Native `start`, `stop`, and detached internals are rejected in API mode to prevent a duplicate native supervisor alongside an active Compose deployment; clear the API URL only when intentionally returning to native process management.

Install zsh completion by writing the generated script somewhere in your zsh `fpath`, then initializing completions. One local-user option is:

```sh
mkdir -p ~/.zsh/completions
dagent completion zsh > ~/.zsh/completions/_dagent
```

Then ensure your `~/.zshrc` contains:

```sh
fpath=(~/.zsh/completions $fpath)
autoload -Uz compinit
compinit
```

Open a new shell after updating completion. The zsh completion script completes top-level commands, persistent runtime configuration, `services` actions and service names, Calendar credential-file paths after `-f` or `--credentials-file`, Telegram auth options, and `completion zsh`.

## Configuration

- Telegram credentials are normally configured with `dagent --runtime-directory <live-folder> services auth telegram --bot-token <token> --user-id <numeric-id>`, which stores them at `<live-folder>/data/telegram/credentials.json` for later startup.
- `TELEGRAM_ENABLED` defaults to `true`. Run `dagent --runtime-directory <live-folder> services disable telegram` to persist this preference in `.settings`, or set it in `.env`/process env as an override, to start the app without Telegram credentials or long polling.
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USER_ID` are optional `.env` overrides for the persisted Telegram credentials. `TELEGRAM_ALLOWED_USER_ID` must be your numeric Telegram `message.from.id`; usernames are never accepted for access control.
- `OPENCODE_SERVER_HOSTNAME` defaults to `127.0.0.1` and configures the managed `opencode serve` hostname.
- `OPENCODE_SERVER_PORT` defaults to `4096` and configures the managed `opencode serve` port.
- `OPENCODE_SERVER_DIRECTORY` defaults to `/Users/davidsnir/ai-projects/personal-agent` and is the managed server process working directory.
- `OPENCODE_SERVER_PRINT_LOGS` defaults to `true`; when enabled, the app passes `--print-logs` and forwards opencode process output.
- `OPENCODE_SERVER_AUTO_START` defaults to `true`. Run `dagent --runtime-directory <live-folder> services disable opencode` to persist this preference in `.settings`, or set it in `.env`/process env as an override, to use an already-running opencode server.
- `OPENCODE_SERVER_URL` defaults to `http://<OPENCODE_SERVER_HOSTNAME>:<OPENCODE_SERVER_PORT>` and configures HTTP requests to opencode.
- `OPENCODE_REQUEST_TIMEOUT_MS` defaults to `120000` and bounds Telegram/agent requests to opencode. It must not exceed `600000`.
- `OPENCODE_SERVER_USERNAME` and `OPENCODE_SERVER_PASSWORD` enable HTTP basic auth for a protected opencode server. The username defaults to `opencode` when only a password is set.
- `OPENCODE_AGENT` optionally selects the opencode agent for messages.
- `OPENCODE_MODEL` optionally selects the initial opencode model for messages. In Telegram, `/model <provider/model>` can change the model for the running process.
- `OPENCODE_DIRECTORY` optionally sets opencode's HTTP `directory` query parameter and is also included in created session titles for visibility. If omitted, opencode uses the server process current directory. This is separate from `OPENCODE_SERVER_DIRECTORY`.
- `GOOGLE_CALENDAR_ENABLED` defaults to `false`. Run `dagent --runtime-directory <live-folder> services enable calendar` to persist this preference in `.settings`, or set it in `.env`/process env as an override, so the app starts a background Google Calendar SQLite cache service.
- `GOOGLE_CALENDAR_CLIENT_ID` and `GOOGLE_CALENDAR_CLIENT_SECRET` are required for the first `dagent services auth calendar` unless you use a credentials JSON file. After successful auth, `auth`, `sync`, and `status` can fall back to the OAuth client credentials persisted in SQLite.
- `GOOGLE_CALENDAR_CREDENTIALS_PATH` optionally points to a downloaded Google Cloud `credentials.json` file with an `installed` or `web` OAuth client. Relative paths resolve from the selected runtime directory. This lets background sync use file-based credentials when `GOOGLE_CALENDAR_ENABLED=true`.
- `GOOGLE_CALENDAR_DB_PATH` defaults to `<runtimeDirectory>/data/google-calendar/google-calendar.sqlite`. The parent directory is created automatically; this database stores local Calendar cache data and Google OAuth secrets.
- `GOOGLE_CALENDAR_SYNC_PAST_DAYS` defaults to `30`; `GOOGLE_CALENDAR_SYNC_FUTURE_DAYS` defaults to `90`.
- `GOOGLE_CALENDAR_SYNC_INTERVAL_SECONDS` defaults to `60` for the background cache service.
- `GOOGLE_CALENDAR_AUTH_REDIRECT_PORT` defaults to `0`, which asks the OS to choose a local OAuth callback port.
- `WHATSAPP_DB_PATH` defaults to `<runtimeDirectory>/data/whatsapp/whatsapp.sqlite`.
- `WHATSAPP_WORKER_INTERVAL_SECONDS` defaults to `60` for the control API scheduled-send loop.
- `WHATSAPP_SEND_TIMEOUT_MS` defaults to `120000` for scheduled sends. `WHATSAPP_LIFECYCLE_TIMEOUT_MS` defaults to `10000` for WAHA reads and lifecycle calls; startup reconciliation has a separate finite `WHATSAPP_STARTUP_RECONCILE_TIMEOUT_MS` deadline, default `30000`.
- `WAHA_API_KEY` and `WAHA_WEBHOOK_SECRET` override Compose's local-development defaults. Set strong, independent values for production. `WAHA_BASE_URL` is `http://waha:3000` inside Compose.
- `DAGENT_CLI_API_TIMEOUT_MS` defaults to `120000` and bounds each native CLI request to the control API. `DAGENT_AGENT_RUNTIME_DIRECTORY`, `DAGENT_AGENT_OPENCODE_CONFIG_PATH`, `DAGENT_TELEGRAM_RUNTIME_DIRECTORY`, `DAGENT_WHATSAPP_RUNTIME_DIRECTORY`, and `DAGENT_AGENT_RESTART_COMMAND` are optional control API overrides for non-standard deployments. Standard Compose maps the control API only at `http://127.0.0.1:8000`, mounts WhatsApp SQLite separately at `/whatsapp-runtime`, and keeps WAHA port 3000 internal.

## Google Calendar Cache And MCP

Calendar support is disabled by default and does not affect Telegram/opencode behavior unless `GOOGLE_CALENDAR_ENABLED=true`.

1. Create a Google Cloud OAuth client for an installed/desktop app.
2. Either set `GOOGLE_CALENDAR_CLIENT_ID` and `GOOGLE_CALENDAR_CLIENT_SECRET` in `.env`, set `GOOGLE_CALENDAR_CREDENTIALS_PATH` to the downloaded `credentials.json`, or pass the file per command with `-f`.
3. Build and link the CLI with `npm run build` and `npm link`.
4. Initialize runtime directories and opencode MCP config with `dagent --runtime-directory <live-folder> services init`.
5. Authorize once with `dagent --runtime-directory <live-folder> services auth calendar` or `dagent --runtime-directory <live-folder> services auth calendar -f /path/to/credentials.json`. This opens a browser, requests Calendar read/event and account-email scopes, receives the OAuth callback on localhost, stores the refresh token plus OAuth client ID/secret in SQLite, and ensures the runtime opencode Calendar MCP entry exists. If you authorized before event-write tools were added, run auth again and revoke the old app grant first if Google does not return a refresh token.
6. Run a foreground sync with `dagent --runtime-directory <live-folder> services sync calendar`. Pass `-f /path/to/credentials.json` only when you want to override the persisted or env credentials for that invocation.
7. Check cache state with `dagent --runtime-directory <live-folder> services status calendar`.

The long form is `--credentials-file /path/to/credentials.json`. If both env client ID/secret and `GOOGLE_CALENDAR_CREDENTIALS_PATH` are set, the explicit env client ID/secret win. A CLI `-f` or `--credentials-file` path overrides both env credentials and the env credentials path for that invocation. When no CLI/env credentials are present, `auth`, `sync`, and `status` fall back to the OAuth client ID/secret saved by the last successful auth. Treat the SQLite database under `GOOGLE_CALENDAR_DB_PATH` as local secret data because it stores OAuth tokens and OAuth client credentials; status output reports only booleans/paths, not secret values.

The local stdio MCP server runs as `dagent services mcp calendar`. It exposes cached read tools (`calendar_list_calendars`, `calendar_view_day`, `calendar_view_range`, `calendar_search_events`, `calendar_next_events`, `calendar_sync_status`), live free-time lookup (`calendar_find_free_time`), and dry-run-by-default write tools (`calendar_create_event`, `calendar_update_event`). Create/update tools require `confirm=true` to call Google Calendar, and `sendUpdates` defaults to `none`. MCP diagnostics are written to stderr because stdout is reserved for protocol messages.

The runtime `opencode.json` includes a local MCP server named `calendar` with command `["dagent", "services", "mcp", "calendar"]` and `environment.DAGENT_RUNTIME_DIRECTORY` set to the selected live folder. Quit and restart opencode after init, auth, building, linking, or changing runtime config so it reloads the MCP definition and can find `dagent` on PATH.

When `dagent services auth calendar` is mediated through CLI API in the standard compose deployment, the API stores Calendar OAuth state under the Calendar runtime but installs Calendar MCP into the agent-visible `/agent-runtime/opencode.json`, backed by the canonical host-root `opencode.json`. It verifies that exact configured path and restarts the `dagent-agent` container through `/var/run/docker.sock` so opencode reloads the config. For non-standard deployments, override `DAGENT_AGENT_OPENCODE_CONFIG_PATH` and `DAGENT_AGENT_RESTART_COMMAND`; if verification fails or the command fails, OAuth/token storage and MCP installation still complete and the CLI reports the non-secret restart status.

When `dagent services auth telegram` is mediated through CLI API in the standard compose deployment, the API writes credentials under the Telegram runtime mounted at `/telegram-runtime`, not the Calendar runtime mounted at `/runtime`.

Do not commit runtime data or secrets: keep live-folder `.env`, `.settings`, `data/`, SQLite/WAL/SHM files, OAuth tokens, client secrets, and generated local config out of git.

## WhatsApp Scheduled Messages

WhatsApp is not part of the native supervisor. Standard Compose runs one internal browserless WAHA GOWS container, the `control-api` scheduler/webhook processor, and the database-only `whatsapp-mcp`. WAHA sessions persist under `${HOME}/.local/share/dagent/data/whatsapp/waha-sessions`; old `whatsapp-web.js` LocalAuth data cannot be migrated and the GOWS `default` session must be paired once.

Setup flow:

```sh
# Recommended for production; local Compose can start with development defaults.
export WAHA_API_KEY='<strong-random-api-key>'
export WAHA_WEBHOOK_SECRET='<independent-strong-random-secret>'
dagent --runtime-directory "${HOME}/.local/share/dagent" services init compose
docker compose up -d
dagent --runtime-directory "${HOME}/.local/share/dagent" cli-api config --url http://127.0.0.1:8000
dagent --runtime-directory "${HOME}/.local/share/dagent" services init
dagent --runtime-directory "${HOME}/.local/share/dagent" services auth whatsapp
dagent --runtime-directory "${HOME}/.local/share/dagent" services sync whatsapp
```

Standard Compose requires a non-empty `HOME` and uses `${HOME}/.local/share/dagent` as the canonical host root. Run `services init compose` before the first `docker compose up`; it creates the required narrow bind sources, initializes the canonical Calendar and WhatsApp databases under `data/google-calendar` and `data/whatsapp`, and installs both exact remote MCP entries into root `opencode.json`. Compose does not mount the whole runtime root into any service. Telegram remains limited to `data/telegram`, the agent workspace remains `agent/workspace`, and port 4096 is published only on loopback.

OpenCode provider credentials use OpenCode's data contract at `/root/.local/share/opencode` in the root-run agent image. Compose persists only that data boundary at `${HOME}/.local/share/dagent/data/opencode`; keep the host directory owner-only and never inspect, print, copy into the repository, or expose its authentication files. Recreating the agent container retains this mount.

`services init|auth|sync|logout|status whatsapp` are remote-only control API operations. Auth polls WAHA and writes terminal QR art without returning or logging the raw QR payload. Sync refreshes exact cached names and `@c.us`/`@g.us` recipient IDs. Status reports non-secret GOWS session, webhook inbox, contact, and schedule state.

Existing runtime CLI API configuration that points to port `7331` must be changed to `http://127.0.0.1:8000` for this deployment.

The local stdio MCP server runs as `dagent services mcp whatsapp`. It is database-only and does not contact WAHA. In standard compose, the agent uses remote HTTP MCP at `http://whatsapp-mcp:7333/mcp`, which is also database-only. Both expose tools to schedule one-shot or recurring messages by exact cached recipient display name, find cached recipients for discovery, list scheduled messages with previews and recurrence metadata, cancel pending or failed messages, and read status. Missing or ambiguous recipient names are rejected instead of fuzzy matched.

The runtime `opencode.json` includes a local MCP server named `whatsapp` with command `["dagent", "services", "mcp", "whatsapp"]` and `environment.DAGENT_RUNTIME_DIRECTORY` set to the selected live folder. In standard Compose, CLI API installs a remote WhatsApp MCP entry into the canonical root config with URL `http://whatsapp-mcp:7333/mcp` and restarts the agent container when possible. Restart opencode after init/build/link/config changes so it reloads the MCP definition.

## Telegram Commands

- `/start` shows a short usage message.
- `/health` checks `GET /global/health` on the opencode server.
- `/new` creates a fresh opencode session for the chat.
- `/model` lists available opencode model IDs; `/model <provider/model>` sets the model for future messages until restart.
- Any other text is sent to the chat's current opencode session, creating one if needed.

Sessions are stored in memory as `chatId -> sessionId`, so restarting the bot clears the mapping.

## Services

Use `dagent --runtime-directory <live-folder> services list`, `services status [service]`, `services enable <service>`, and `services disable <service>` to inspect or persist native service settings in the selected runtime `.settings`. Process env and runtime `.env` values still override `.settings`. Native toggle names are `opencode`, `telegram`, `calendar`, and `api`; WhatsApp lifecycle operations are remote-only.

- `OpencodeServerService` starts and stops the local `opencode serve` child process when auto-start is enabled.
- `OpencodeAgent` implements the generic agent interface using the opencode HTTP API.
- `TelegramConnectionService` owns Bot API long polling, owner authorization, command handling, message forwarding, and graceful polling shutdown.
- `GoogleCalendarCacheService` is added only when `GOOGLE_CALENDAR_ENABLED=true`; it periodically syncs Google Calendar data to SQLite and stores per-calendar errors without crashing the app.

On `SIGINT` or `SIGTERM`, the app stops started services in reverse order. If opencode exits unexpectedly after startup, the app treats that as a fatal service error and shuts down.
