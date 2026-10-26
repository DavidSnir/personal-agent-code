# CLI Services Instructions

## Scope

This file covers the implemented Personal Agent CLI command surface after the service-operations reorganization. It documents canonical commands, removed legacy command groups, local and cli-api-mediated command behavior, and safe verification rules.

## Context

`cli/src/cli.ts` is the compiled operator CLI entry point. `package.json` exposes both `DAgent` and `dagent` bins pointing at `dist/cli/src/cli.js`; lowercase `dagent` is the preferred spelling in help and documentation, while uppercase `DAgent` remains supported for existing installed workflows.

Standard Compose uses the fixed host root `${HOME}/.local/share/dagent`. Use `dagent --runtime-directory "${HOME}/.local/share/dagent" ...` when native CLI commands must share Compose data. CLI runtime overrides remain general-purpose, and cwd fallback does not infer the Compose root.

The runtime-independent `dagent config runtime-directory` command shows the persistent default; `--path <absolute-path>` sets it and `--clear` removes it. It stores `${XDG_CONFIG_HOME:-$HOME/.config}/dagent/config.json`, not runtime data. Selection precedence is flag, `DAGENT_RUNTIME_DIRECTORY`, persistent config, then cwd. This command always remains local even when cli-api is configured and does not create or migrate the selected runtime.

Service operations are consolidated under the plural `services` command group. The old top-level dispatch groups were intentionally removed instead of retained as compatibility aliases. Future changes must not silently restore these legacy command surfaces unless the user explicitly asks for compatibility.

When a CLI API URL is configured, supported app-control commands use dedicated DAgent HTTP endpoints. Broad `POST /cli` subprocess execution is disabled. WhatsApp lifecycle is remote-only because Compose `control-api` owns WAHA session `default`, contact sync, and status. Configure `DAGENT_CLI_API_URL` or `dagent cli-api config --url http://127.0.0.1:8000`; the latter stores settings under `<runtimeDirectory>/data/dagent/cli-api.json`. Token precedence is `DAGENT_CLI_API_TOKEN`, `DAGENT_API_TOKEN`, then stored token, and output never prints token values. `DAGENT_CLI_API_TIMEOUT_MS` defaults to `120000`, is capped at `600000`, and bounds each request. With no effective API URL, native commands continue to access the selected host runtime directly.

Canonical commands are:


```sh
dagent start
dagent stop

dagent services list
dagent services status [opencode|telegram|calendar|whatsapp|api]
dagent services enable <opencode|telegram|calendar|api>
dagent services disable <opencode|telegram|calendar|api>

dagent services auth telegram --bot-token <token> --user-id <numeric-id>
dagent services auth calendar [-f <credentials.json>]
dagent services auth whatsapp

dagent services logout whatsapp

dagent services sync calendar [-f <credentials.json>]
dagent services sync whatsapp

dagent services init
dagent services init compose
dagent services init whatsapp

dagent services mcp calendar
dagent services mcp whatsapp

dagent completion zsh
dagent config runtime-directory [--path <absolute-path> | --clear]
dagent cli-api config [--url <url>] [--token <token>] [--clear-token]
dagent help
```

The removed command surfaces are:

```sh
dagent service ...
dagent telegram ...
dagent google-calendar ...
dagent whatsapp ...
dagent agent start
dagent agent stop
```

Those commands should fail with `Unknown command:`. Tests in `test/cliCommands.test.mjs` assert the removed surfaces remain absent from top-level help and fail when invoked.

Important implementation files:

- `package.json` and `package-lock.json` define both CLI bins.
- `cli/src/cli.ts` parses global runtime-directory options, dispatches canonical commands, prints help/completion, and owns detached process wrappers.
- `shared/utils/serviceSettings.ts` defines service names, env toggles, defaults, aliases, and `.settings` persistence.
- `services/telegram/src/app.ts` starts all enabled app services for `dagent start`/`npm start`.
- `services/agent/src/opencode/runtimeConfig.ts` writes opencode MCP entries using `dagent services mcp calendar|whatsapp`.
- `test/cliCommands.test.mjs` and `test/serviceSettings.test.mjs` cover CLI routing and native toggles.
- `services/cli-api/src/dagentApiService.ts` implements dedicated service/deployment routes and explicitly rejects broad `/cli` execution and native lifecycle routes.

Action routing:

- `services list` prints enablement status for all services.
- `services status` with no service prints enablement status for all services.
- `services status opencode` prints opencode enablement status only.
- `services status telegram` delegates to Telegram credential status.
- `services status calendar` delegates to Google Calendar cache/status.
- `services status whatsapp` requires the control API and returns non-secret WAHA/SQLite status.
- `services status api` prints DAgent HTTP control API enablement status.
- `services enable|disable <service>` persists the selected runtime `.settings` boolean and does not live-start or live-stop a running process.
- In cli-api-mediated mode, top-level `start`, `stop`, and private detached execution are rejected before a request is sent, preventing a duplicate native supervisor beside Compose.
- In cli-api-mediated mode, `services list`, native service status/enable/disable, Telegram status/auth, Calendar status/auth/sync, WhatsApp operations, and safe deployment init use dedicated endpoints. Top-level `init` and `services init [compose]` map only to `POST /deployment/init`, which updates Compose MCP config and may restart the agent but cannot create missing host bind sources or databases.
- In cli-api-mediated mode, `services auth telegram --bot-token <token> --user-id <numeric-id>` calls bearer-authorized `POST /telegram/auth` with JSON `{ botToken, userId }`; it does not use `/cli` or write host-local credentials directly.
- In cli-api-mediated mode, `services auth calendar [-f <credentials.json>]` calls `POST /calendar/auth/start`, prints the returned Google URL, polls `GET /calendar/auth/sessions/:id`, and waits for the public API callback to exchange the code. The optional `-f` file is read locally by the CLI and converted to uploaded OAuth client credentials; it is not resolved on the API/container filesystem.
- In cli-api-mediated mode, `services init|auth|sync|logout|status whatsapp` calls dedicated `/whatsapp/...` endpoints. Auth polls WAHA and displays safe terminal QR art; sync polls a control-api operation; completed init/auth may install remote MCP config and restart the agent after path checks.
- Local/meta commands stay local even when a CLI API URL is configured: `help`, `--help`, `completion zsh`, `config runtime-directory`, `cli-api config`, `services --help`, `services help`, and `services mcp calendar|whatsapp`. Private detached execution is rejected in API mode.
- Native `services auth telegram` remains unchanged and stores Telegram credentials directly in the selected runtime.
- With Compose-sharing invocation `dagent --runtime-directory "${HOME}/.local/share/dagent" services auth|status telegram`, the credential contract resolves to `${HOME}/.local/share/dagent/data/telegram/credentials.json`.
- `services auth calendar` runs Google OAuth and installs the Calendar MCP entry.
- `services auth whatsapp` pairs the WAHA `default` GOWS session through control-api.
- `services logout whatsapp` logs out the WAHA `default` session.
- `services sync calendar` runs one foreground Calendar cache sync.
- `services sync whatsapp` refreshes cached WhatsApp contacts using the stored session.
- `services init` initializes shared runtime directories, databases, and default MCP config.
- Local `services init compose` with no effective CLI API URL creates required private narrow bind sources, canonical Calendar/WhatsApp DBs, and both exact remote MCP entries in root `opencode.json`; it does not start services. Run it before configuring/starting control-api on a fresh root.
- `services init whatsapp` initializes only WhatsApp data/schema and the WhatsApp MCP entry.
- `services start whatsapp` and `services stop whatsapp` were removed; Compose owns WAHA lifecycle.
- `services mcp calendar|whatsapp` starts a stdio MCP server and is intended for opencode or another MCP client, not normal interactive status use.
- `cli-api config` shows or updates the selected runtime's `<runtimeDirectory>/data/dagent/cli-api.json`; use `--clear-token` to remove the stored token without changing the URL.
- `config runtime-directory` shows or updates the runtime-independent user default; corrupt config fails clearly, and `--clear` is the recovery path.

## Service Enablement

Runtime services are:

| Service | Env Setting | Default | Startup Effect |
| --- | --- | --- | --- |
| `opencode` | `OPENCODE_SERVER_AUTO_START` | `true` | Starts managed `opencode serve` when enabled. |
| `telegram` | `TELEGRAM_ENABLED` | `true` | Starts Telegram long polling when enabled. |
| `calendar` | `GOOGLE_CALENDAR_ENABLED` | `false` | Starts Google Calendar background cache sync when enabled. |
| `api` | `DAGENT_API_ENABLED` | `false` | Starts the DAgent HTTP control API when enabled. |

`services enable` and `services disable` only write selected-runtime `.settings`. They must not live-start or live-stop an already-running supervisor. If enabled services change while DAgent is running, the operator should restart:

```sh
dagent stop
dagent start
```

Accepted service aliases include `opencode-server` for `opencode`, `google-calendar` for `calendar`, and `dagent-api` for `api`; output uses canonical names.

## Rules

`dagent start` should start the detached app supervisor and run every enabled service in one process.

`dagent stop` should stop that supervisor. Shutdown should stop all successfully started services in reverse order.

The app should continue using the existing app-service lifecycle shape:

```ts
type AppService = {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
};
```

- Preserve runtime-directory selection order: explicit flag, `DAGENT_RUNTIME_DIRECTORY`, persistent user config, then cwd.
- Prefer an explicit runtime override; use `${HOME}/.local/share/dagent` only when the command should operate on standard Compose data.
- Preserve selected-runtime `.settings` as the persistence target for service enablement.
- Keep CLI API mediation opt-in. Do not make local CLI app-control commands depend on a running API unless a CLI API URL is configured through env or runtime config.
- Keep every remote operation on a dedicated reviewed endpoint; do not restore arbitrary argv execution through `/cli`.
- While an API URL is configured, reject `start`, `stop`, and private detached execution rather than proxying or running them locally.
- Preserve the bounded `DAGENT_CLI_API_TIMEOUT_MS` contract and maximum.
- Keep remote Calendar auth credential-file semantics host-native: parse `-f` on the CLI side, upload only OAuth client ID/secret fields, and do not forward credential file paths to the API.
- Keep remote Telegram auth on `POST /telegram/auth`; preserve positive safe-integer user-ID validation, bearer authorization, token-redacted output, and shared credential persistence.
- Keep WhatsApp lifecycle remote-only: the host CLI may display QR art returned by control-api but must not create local session state or contact WAHA directly.
- Keep help, services help, completion, runtime-directory config, CLI API config, internal detached commands, and MCP stdio server commands local.
- Do not print stored or effective CLI API token values; expose only token presence/source metadata.
- Do not print Telegram tokens, Google OAuth secrets, WhatsApp session data, or other runtime secrets.
- Keep `dagent services init` safe: no Telegram polling, opencode startup, OAuth browser flow, WAHA auth, or live sync startup.
- Keep `services init compose` deterministic: canonical DB paths and exact remote MCP URLs must not be redirected by ambient DB/MCP env overrides.
- Keep Calendar OAuth under `dagent services auth calendar`.
- Keep WhatsApp QR auth under remote `dagent services auth whatsapp`.
- Keep MCP commands as stdio server modes intended for MCP clients, not normal interactive status commands.
- Keep removed legacy top-level commands failing until compatibility is explicitly requested.
- Prefer lowercase `dagent` in new help, README, and instruction examples.
- Do not run startup or WAHA lifecycle commands during automated documentation verification unless explicitly approved.

## Verification

Run static and test checks:

```sh
npm test
npm run typecheck
npm run build
```

Run non-startup CLI checks after build:

```sh
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
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services status api
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services disable telegram
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services enable telegram
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services init
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services init compose
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services auth telegram --bot-token "fake-test-token" --user-id "123456"
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services status telegram
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services status calendar
```

To test API-mediated CLI mapping without startup, use `test/cliCommands.test.mjs`; it covers dedicated route mapping, stored URL precedence, request timeout, local stdio MCP behavior, native supervisor rejection, Compose init, Telegram token redaction, and port `8000`. `test/dagentApiRouting.test.mjs` verifies exact deployment MCP installation plus rejection of broad CLI/supervisor routes. `test/dagentApiTelegramAuth.test.mjs` verifies Telegram authorization, numeric-ID rejection, secret-free responses, runtime selection, and credential modes.

If `npm link` is available and safe, verify both binary names:

```sh
dagent help
DAgent help
dagent services --help
```

Do not run native startup, `docker compose up`, or remote WhatsApp auth/sync/logout during automated verification unless the user explicitly approves runtime and account side effects.

The full remediation was reported verified on 2026-07-22 with 82 tests, typecheck, full/service builds, focused routing/timeout/init tests, Compose rendering, and live loopback control health. No duplicate native supervisor remained. WhatsApp pairing still requires user QR re-authentication.

## Child Instructions

| Instruction File | Description |
| --- | --- |
