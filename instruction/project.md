# Personal Agent Project Instructions

## Scope

This file covers the overall Personal Agent project purpose, layout, runtime configuration, and verification. Read this after `AGENTS.md` before changing application code, then follow the most specific child instruction file for the subsystem you touch.

## Context

Personal Agent is a private Node.js and TypeScript multi-service Telegram/opencode assistant. It connects authorized Telegram chats to `opencode serve`, maintains an optional Google Calendar SQLite cache, and schedules WhatsApp messages through an internal WAHA GOWS container, control API, SQLite database, and database-only MCP server.

This repository is the code repository. The user-selected CLI live folder is the runtime directory: runtime `.env`, `.settings`, generated `opencode.json`, SQLite databases, OAuth tokens, Telegram credential files, pid/log files, and service data are created and read there. Standard Compose instead requires non-empty `HOME`, fixes its host root at `${HOME}/.local/share/dagent` (rendered as `/Users/davidsnir/.local/share/dagent` on this computer), and persists WAHA pairing state under `data/whatsapp/waha-sessions`. Do not assume the code repository is the live runtime directory.

The compiled CLI is exposed as both `dagent` and `DAgent`; lowercase `dagent` is preferred in new docs and help examples. Canonical service operations are under `dagent services ...`. Removed legacy command groups (`service`, `telegram`, `google-calendar`, `whatsapp`, and `agent`) are intentionally not aliases and should keep failing unless compatibility is explicitly requested.

The active TypeScript source is split across `cli/src`, `services/{telegram,cli-api,agent,calendar,whatsapp}/src` and `shared/utils`; the old top-level `src/` tree was removed. `services/telegram/src/index.ts` awaits `runApp()` from `services/telegram/src/app.ts` and reports startup failures. `dagent start` spawns a detached background supervisor, writes stdout/stderr to `<runtimeDirectory>/data/dagent/dagent.log`, tracks the pid at `<runtimeDirectory>/data/dagent/dagent.pid`, and starts every enabled app service. `dagent stop` sends `SIGTERM` to that supervisor. `npm start` runs `node dist/services/telegram/src/index.js` in the foreground and selects runtime from `DAGENT_RUNTIME_DIRECTORY`, then persistent user config, then `process.cwd()`.

`runApp()` loads runtime config, reads service settings, builds services in dependency order, starts them sequentially, and stops successfully started services in reverse order on startup failure, `SIGINT`, `SIGTERM`, or fatal service error. Enabled startup effects are:

- `OPENCODE_SERVER_AUTO_START=true` starts managed `opencode serve` through `OpencodeServerService`; when false, the app expects an existing server at `OPENCODE_SERVER_URL` if a client needs one.
- `TELEGRAM_ENABLED=true` loads Telegram credentials, creates the opencode HTTP adapter for Telegram, and starts `TelegramConnectionService` long polling.
- `GOOGLE_CALENDAR_ENABLED=true` starts `GoogleCalendarCacheService` background sync.
- `DAGENT_API_ENABLED=true` starts the HTTP control API for service status and enablement toggles.

Fatal service errors include unexpected managed `opencode serve` exit and unexpected Telegram polling stop/rejection when Telegram is enabled. WhatsApp is not part of this native supervisor; Compose owns its WAHA/control lifecycle. Compiled JavaScript is emitted to `dist/`, which is ignored by git. `tsconfig.json` sets `rootDir` to `.` and includes `cli/src/**/*.ts`, `services/*/src/**/*.ts`, and `shared/**/*.ts`, so compiled paths mirror the repository layout under `dist/`.

Important files:

- `services/telegram/src/index.ts` is the foreground application entry point.
- `services/telegram/src/app.ts` owns enabled-service startup, shutdown, ordering, and fatal errors.
- `services/telegram/src/telegramIndex.ts` is the Docker Telegram-only entry point.
- `services/telegram/src/telegramService.ts` starts only Telegram polling for containers.
- `cli/src/cli.ts` is the compiled `dagent`/`DAgent` CLI entry point.
- `shared/utils/runtimeDirectory.ts` defines runtime-directory selection and service data path helpers.
- `shared/utils/userConfig.ts` owns runtime-independent persistent user configuration.
- `shared/utils/serviceSettings.ts` defines runtime service names, env mappings, defaults, aliases, status reading, and `.settings` persistence.
- `services/telegram/src/config.ts` loads runtime `.env` values and effective Telegram/opencode config.
- `shared/service/appService.ts` defines the shared `start()` and `stop()` lifecycle contract.
- `services/telegram/src/telegram/opencodeServerService.ts` manages the local `opencode serve` child process.
- `services/telegram/src/telegram/telegramConnectionService.ts` implements raw Telegram Bot API long polling.
- `services/telegram/src/telegram/opencodeTelegramAgent.ts` is Telegram's local opencode HTTP adapter.
- `services/calendar/src/googleCalendarCacheService.ts` optionally runs periodic Google Calendar cache sync.
- `services/cli-api/src/dagentApiService.ts` implements the HTTP control API and WAHA webhook endpoint.
- `services/cli-api/src/whatsapp/` owns WAHA requests, lifecycle, sends, and webhook processing.
- `services/agent/src/agents/opencodeAgent.ts` and `services/agent/src/opencode/opencodeClient.ts` implement the non-container opencode-backed agent boundary.
- `services/agent/src/opencode/runtimeConfig.ts` installs runtime `opencode.json` Calendar and WhatsApp MCP entries.
- `shared/utils/telegramCredentials.ts` owns Telegram credential validation, persistence, paths, and status; `services/telegram/src/telegram/credentials.ts` re-exports it for service compatibility.
- `services/calendar/src/google/` contains Google Calendar config, OAuth, sync, time, and SQLite repository modules.
- `services/calendar/src/workerIndex.ts` is the foreground Calendar worker entry point for containers.
- `services/calendar/src/mcp/googleCalendarMcpServer.ts` implements Calendar MCP tools for stdio and HTTP transports.
- `services/whatsapp/src/whatsapp/` contains shared WhatsApp config and durable SQLite repository code.
- `services/whatsapp/src/mcp/whatsappMcpServer.ts` implements database-only WhatsApp stdio and HTTP MCP transports.
- `services/whatsapp/src/mcp/httpIndex.ts` is the WhatsApp image's database-only HTTP entrypoint.
- `services/{agent,telegram,cli-api,calendar,whatsapp}/Dockerfile` are service-specific image definitions.
- The root `package.json` is not an npm workspace root. It owns aggregate dev/test/build scripts and devDependencies only. `cli/` and `services/{agent,telegram,cli-api,calendar,whatsapp}/` are independent private npm packages, each with its own `package.json` and `package-lock.json`; runtime dependencies belong to the package that imports or executes them.
- `shared/utils/` contains active cross-service runtime-directory and service-settings helpers; `shared/service/` contains shared service lifecycle types; `shared/types/` is reserved for additional shared types.
- `.env.example` documents supported configuration without storing secrets.
- `README.md` contains human-facing setup and usage notes.
- `package.json` defines whole-repo `build`, `cli`, `start`, `test`, and `typecheck` scripts, service-scoped `build:telegram`, `build:calendar`, `build:cli-api`, and `build:whatsapp` scripts, plus both `DAgent` and `dagent` bins pointing at `dist/cli/src/cli.js`.

Runtime configuration:

- Compose's canonical host runtime root is `${HOME}/.local/share/dagent`, independent of repository cwd. Run `dagent --runtime-directory "${HOME}/.local/share/dagent" services init compose` before first container creation. It creates owner-only bind sources, canonical DBs, `.settings`, and root `opencode.json`. Compose mounts only `agent/workspace`, root `opencode.json`, and service subtrees under `data/{google-calendar,opencode,telegram,whatsapp}` using `create_host_path: false`; it never mounts the whole runtime root. Optional service env files are under their owning `data/<service>/.env` paths, except agent env at `agent/.env`.
- Compose explicitly supplies deterministic local-development fallbacks for `WAHA_API_KEY` and `WAHA_WEBHOOK_SECRET`, so parsing and local `docker compose up` work without operator values. Production must override both through Compose interpolation with strong independent secrets. Explicit Compose `environment` entries override same-named values from `env_file`; do not assume `${HOME}/.local/share/dagent/data/whatsapp/.env` alone replaces the fallbacks.
- Runtime directory selection is explicit `-r`/`--runtime-directory`, then `DAGENT_RUNTIME_DIRECTORY`, then `${XDG_CONFIG_HOME:-$HOME/.config}/dagent/config.json`, then invocation cwd.
- Non-CLI app startup has no flag and uses the same remaining order: env, persistent user config, then cwd.
- `dagent config runtime-directory` shows the default; `--path <absolute-path>` stores a normalized absolute path and `--clear` removes it. Writes are atomic with directory mode `0700` and file mode `0600`; configuration neither creates nor migrates the runtime, remains local with cli-api configured, and clear can recover corrupt config.
- Default `.env`, default `.settings`, and relative `DOTENV_CONFIG_PATH` values resolve from the selected runtime directory.
- Telegram credentials normally come from `dagent services auth telegram`, which stores them at `<runtimeDirectory>/data/telegram/credentials.json`. To operate on standard Compose data, use `dagent --runtime-directory "${HOME}/.local/share/dagent" ...`; CLI overrides may still select any other live folder, and cwd fallback remains unchanged.
- `TELEGRAM_ENABLED` defaults to `true`; when false, startup skips Telegram credential loading and long polling.
- `OPENCODE_SERVER_URL` defaults to `http://127.0.0.1:4096`.
- `OPENCODE_REQUEST_TIMEOUT_MS` defaults to `120000`, must be a positive integer no greater than `600000`, and bounds Telegram/agent HTTP requests to opencode.
- `OPENCODE_SERVER_HOSTNAME` defaults to `127.0.0.1` and `OPENCODE_SERVER_PORT` defaults to `4096` for managed server startup.
- `OPENCODE_SERVER_DIRECTORY` defaults to `/Users/davidsnir/ai-projects/personal-agent`; relative overrides resolve from the runtime directory.
- `OPENCODE_SERVER_AUTO_START` defaults to `true` and is the `opencode` service toggle.
- `OPENCODE_AGENT`, `OPENCODE_MODEL`, and `OPENCODE_DIRECTORY` customize opencode requests; Telegram `/model` can list available opencode models and change the selected model for the running process.
- `GOOGLE_CALENDAR_ENABLED` defaults to `false`; when true, the background cache service starts without changing Telegram/opencode behavior when false.
- `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`, `GOOGLE_CALENDAR_CREDENTIALS_PATH`, `GOOGLE_CALENDAR_DB_PATH`, sync-window variables, and auth redirect port are documented in `instruction/google-calendar.md`.
- WhatsApp has no native service toggle. WAHA and scheduled sending are Compose/control-API owned; DB, session, webhook, and request settings are documented in `instruction/whatsapp.md`.
- `DAGENT_API_ENABLED` defaults to `false`; when true, startup includes the DAgent HTTP control API documented in `instruction/dagent-api.md`.
- `DAGENT_API_HOSTNAME` defaults to `127.0.0.1`, `DAGENT_API_PORT` defaults to `8000`, and optional `DAGENT_API_TOKEN` enables bearer-token API authorization.
- `DAGENT_CLI_API_URL` is an env override for the native CLI API connection. The same setting can be stored per runtime with `dagent cli-api config --url <url>`; env still wins. `DAGENT_CLI_API_TOKEN`, then `DAGENT_API_TOKEN`, then the runtime cli-api config token provide bearer auth. When configured, supported operations use dedicated endpoints; broad `/cli` execution is disabled, native `start`/`stop`/detached internals are rejected, and stdio MCP commands remain local. `DAGENT_CLI_API_TIMEOUT_MS` defaults to `120000` with maximum `600000` and bounds every host CLI request.
- `DAGENT_AGENT_RUNTIME_DIRECTORY`, `DAGENT_AGENT_OPENCODE_CONFIG_PATH`, `DAGENT_TELEGRAM_RUNTIME_DIRECTORY`, `DAGENT_WHATSAPP_RUNTIME_DIRECTORY`, WAHA credentials/base URL, MCP transport values, and `DAGENT_AGENT_RESTART_COMMAND` configure control-api routing. Standard Compose writes the shared host root config through `/agent-runtime/opencode.json`, while the agent reads the same file through `/runtime/opencode.json`; Telegram, Calendar, and WhatsApp mounts expose only their canonical service subtrees.
- `dagent services enable|disable <service>` persists only native services: `OPENCODE_SERVER_AUTO_START`, `TELEGRAM_ENABLED`, `GOOGLE_CALENDAR_ENABLED`, and `DAGENT_API_ENABLED`.

Operator CLI behavior:

- Build before running compiled CLI commands; during development use `node dist/cli/src/cli.js ...`, and after `npm link` operators can use `dagent` or `DAgent`.
- `dagent help`, `dagent --help`, and `dagent -h` print top-level CLI help. Invoking the CLI without a command prints help and exits non-zero.
- `dagent services init` initializes native runtime data, Calendar/WhatsApp SQLite schemas, and local/default MCP entries without starting services. `dagent services init compose` creates canonical private bind sources and DBs and installs both exact remote MCP entries.
- Top-level `dagent init` still exists as a safe compatibility spelling for shared runtime initialization, but help examples prefer `dagent services init`.
- `dagent start` and `dagent stop` manage the detached supervisor only when no CLI API URL is configured; API mode rejects them to avoid duplicate native services beside Compose.
- `dagent services list`, `status`, `enable`, and `disable` inspect or persist supported runtime service toggles without starting the supervisor.
- `dagent services auth telegram --bot-token <token> --user-id <numeric-id>` stores credentials natively without a CLI API URL; with an API URL it calls bearer-authorized `POST /telegram/auth`, which persists through the same shared helper in the configured Telegram runtime. `dagent services status telegram` prints non-secret credential status JSON.
- `dagent services auth|sync|status|mcp calendar` is the Calendar CLI surface; credentials-file precedence and MCP details are documented in `instruction/google-calendar.md`.
- `dagent services init|auth|sync|logout|status whatsapp` are remote-only control-API operations; `services mcp whatsapp` remains local and database-only.
- `dagent cli-api config [--url <url>] [--token <token>] [--clear-token]` shows or updates runtime-scoped native CLI API connection settings. Output never prints the token value, only whether one is configured.
- `dagent config runtime-directory [--path <absolute-path> | --clear]` manages the runtime-independent persistent default and reports its effective source.
- `dagent help`, `dagent services --help`, `dagent completion zsh`, both config commands, and `dagent services mcp <calendar|whatsapp>` stay local. Private detached execution is blocked in API mode. WhatsApp lifecycle operations require a configured control API and operate on WAHA session `default`.
- `dagent completion zsh` prints a zsh completion script to stdout and does not write shell startup files.

## Rules

- Keep secrets and local runtime state out of git; runtime `.env`, `.env.*`, `.settings`, SQLite databases, OAuth tokens, Telegram credentials, WhatsApp sessions, and generated runtime data must not be committed.
- Do not print, log, or commit Telegram bot tokens, Google OAuth secrets, WAHA credentials, raw QR payloads, webhook bodies, session data, or full scheduled-message bodies.
- Keep the Compose Telegram mount limited to `${HOME}/.local/share/dagent/data/telegram`; do not broaden it to the whole Compose root or unrelated service data without an intentional boundary redesign.
- Keep root `opencode.json` as the exact shared agent/control config, and persist OpenCode provider data only through `data/opencode:/root/.local/share/opencode`.
- Preserve owner-only Telegram access using numeric `from.id`; do not replace it with username matching.
- Preserve shared Telegram credential validation and storage: positive safe-integer owner IDs, `0600` credential files, `0700` service directories, and no token output.
- Preserve Node.js 20+ compatibility because the code relies on built-in `fetch`.
- Keep `dist/` and runtime `data/` treated as generated output and do not commit them.
- Do not touch unrelated live-folder files while maintaining this repository; only create runtime files in an operator-selected or temporary runtime directory when the task requires it.
- Prefer small TypeScript modules under `services/telegram/src/` over adding frameworks until needed.
- Preserve the app-service lifecycle shape when adding services: start dependencies before dependents and stop started services in reverse order.
- Route fatal background service failures through `runApp()` so shutdown can stop dependent services and managed child processes.
- Keep runtime service toggles centralized in `shared/utils/serviceSettings.ts` and document service name, env name, default, and startup effect when adding a toggle.
- Keep Calendar native startup opt-in; WhatsApp QR auth remains an explicit remote CLI flow rather than an implicit prompt.
- Do not replace WAHA's local fallback interpolation with required `${NAME:?...}` expressions; preserve secret-free local Compose parsing/startup and require production overrides operationally.
- Preserve standard Compose service-selection semantics. Service isolation does not require profiles, and targeted builds must remain usable without unrelated service secrets.
- Preserve `npm start` and `services/telegram/src/index.ts -> runApp()` behavior when adding CLI startup commands.
- Preserve the Docker Telegram boundary: `telegramIndex.ts`/`telegramService.ts` starts only Telegram polling and uses `OPENCODE_SERVER_URL` for the separate agent service.
- Do not reintroduce root npm workspaces. Keep root dependency installs, package locks, service package locks, and Docker install/prune rules aligned with `instruction/service-dependency-split-plan.md`.
- Do not run native startup, `docker compose up`, WhatsApp auth/sync/logout, or real WAHA traffic during automated verification unless the user explicitly approves side effects.
- When adding durable behavior, update the relevant child instruction file and README only if humans need the note.
- Preserve reusable opencode workflow and documentation process files unless the user asks to change them.

## Verification

Use these checks after project-level TypeScript changes:

```sh
npm ci
npm test
npm run typecheck
npm run build
```

After Compose environment-boundary changes, verify both global rendering and an unrelated targeted build with WhatsApp secrets removed:

```sh
env -u WAHA_API_KEY -u WAHA_WEBHOOK_SECRET docker compose config
env -u WAHA_API_KEY -u WAHA_WEBHOOK_SECRET docker compose build telegram
npm run build && node --test test/opencodeRuntimeConfig.test.mjs
git diff --check
```

These checks do not start services. Local Compose uses deterministic credential defaults; production deployments must override both WAHA values.

After changing Compose mounts or env files, existing containers retain their previously created mount configuration. Before recreation, stop affected services and migrate any intended `./runtime` tree to `${HOME}/.local/share/dagent` with a permission-preserving tool such as `rsync -a`, after checking destination conflicts; never inspect secret contents, overwrite conflicts, or remove the source until ownership, modes, and non-secret path presence are verified. Then explicitly recreate affected services because restart alone cannot change binds. Do not migrate data or recreate services during documentation-only verification without approval.

After CLI changes, also build first and run non-startup CLI checks only:

```sh
npm run build
node dist/cli/src/cli.js help
node dist/cli/src/cli.js --help
node dist/cli/src/cli.js services --help
node dist/cli/src/cli.js completion zsh
XDG_CONFIG_HOME=/tmp/dagent-config-test node dist/cli/src/cli.js config runtime-directory --path /tmp/personal-agent-runtime-test
XDG_CONFIG_HOME=/tmp/dagent-config-test node dist/cli/src/cli.js config runtime-directory --clear
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test cli-api config
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test cli-api config --url http://127.0.0.1:8000 --token fake-test-token
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services list
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services status telegram
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services disable telegram
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services enable telegram
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services init
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services auth telegram --bot-token "fake-test-token" --user-id "123456"
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services status telegram
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services status calendar
```

To verify runtime-directory behavior, invoke the built CLI from another current working directory with an absolute CLI path. With no runtime option, confirm `runtimeDirectory` is that invocation cwd. With `--runtime-directory <path>`, confirm `runtimeDirectory`, `opencodeConfig.configPath`, and default SQLite DB paths all point under the selected live folder while `currentDirectory` remains only diagnostic.

To run locally with side-effect approval, choose a live folder, optionally copy this repository's `.env.example` to `<live-folder>/.env`, store Telegram credentials, build, then run from the code repository:

```sh
npm run build
dagent --runtime-directory <live-folder> services auth telegram --bot-token <token> --user-id <numeric-id>
dagent --runtime-directory <live-folder> start
dagent --runtime-directory <live-folder> stop
```

`dagent start` returns after launching a detached background process and sends app logs to `<live-folder>/data/dagent/dagent.log`; use `dagent --runtime-directory <live-folder> stop` to close it. Native startup may launch opencode, Telegram polling, Calendar sync, or the API, but never WAHA.

The full post-migration remediation was reported verified on 2026-07-22 with 82 tests, typecheck, full and service builds, targeted images, Compose rendering, empty-`HOME` rejection, and `git diff --check`. Canonical Calendar/WhatsApp data integrity, provider-auth persistence, both root remote MCPs, seven recreated services, loopback agent/control health, a minimal isolated model response, and absence of duplicate native services were also checked. WAHA was healthy and internal, but its persisted pairing ended in `FAILED`; QR re-pairing remains required and WhatsApp authentication must not be reported fixed. See `instruction/compose-runtime.md` for the non-secret migration record.

## Child Instructions

| Instruction File | Description |
| --- | --- |
| instruction/cli-services.md | Canonical CLI services commands and removed legacy surfaces. |
| instruction/telegram-bot.md | Telegram polling, commands, sessions, and message limits. |
| instruction/runtime-directory.md | Runtime path resolution and safe CLI initialization. |
| instruction/dagent-lifecycle.md | Detached DAgent start, stop, pid, and log behavior. |
| instruction/opencode-integration.md | Local opencode HTTP API integration and configuration. |
| instruction/service-settings.md | Runtime service enablement settings and CLI behavior. |
| instruction/dagent-api.md | HTTP control API endpoints, auth, and service toggles. |
| instruction/service-architecture-plan.md | Service lifecycle boundaries and extension rules. |
| instruction/service-isolation-plan.md | Cross-service import and Docker copy isolation plan. |
| instruction/service-layout.md | Repository service layout and source placement rules. |
| instruction/containerization-plan.md | Containerization phases, service boundaries, and Docker verification rules. |
| instruction/google-calendar.md | Google Calendar cache, CLI, sync, and MCP server. |
| instruction/whatsapp.md | WAHA scheduling, webhooks, storage, and MCP behavior. |
| instruction/waha-migration-plan.md | Historical approved WAHA migration plan and acceptance record. |
