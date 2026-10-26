# Runtime Service Settings Instructions

## Scope

This file covers native `dagent services list|status|enable|disable` settings for opencode auto-start, Telegram long polling, Google Calendar sync, and the DAgent HTTP control API.

## Context

Personal Agent lets operators inspect and persist native runtime service toggles without hand-editing environment or secret configuration. The implementation lives in `shared/utils/serviceSettings.ts`. WhatsApp is intentionally absent because Compose owns WAHA lifecycle; WhatsApp lifecycle commands are remote control-API operations, not native toggles.

Supported service names and environment variables are:

| Service | Environment Variable | Default | Runtime effect |
| --- | --- | --- | --- |
| `opencode` | `OPENCODE_SERVER_AUTO_START` | `true` | Controls managed `opencode serve` child startup. |
| `telegram` | `TELEGRAM_ENABLED` | `true` | Controls Telegram credential loading and long polling. |
| `calendar` | `GOOGLE_CALENDAR_ENABLED` | `false` | Controls Google Calendar background cache service startup. |
| `api` | `DAGENT_API_ENABLED` | `false` | Controls DAgent HTTP control API startup. |

Accepted service aliases are `opencode-server` for `opencode`, `google-calendar` for `calendar`, and `dagent-api` for `api`; status output always reports canonical names. Boolean parsing accepts `true`, `1`, `yes`, `on`, `false`, `0`, `no`, and `off`; invalid values throw an error.

`shared/utils/serviceSettings.ts` resolves the persistence file with `getRuntimeSettingsPath(runtimeDirectory)`, which is `<runtimeDirectory>/.settings` after runtime path resolution. `persistRuntimeServiceEnabled()` creates the parent directory when needed, replaces an existing `NAME=...` or `export NAME=...` line in `.settings`, appends the assignment when absent, trims trailing blank lines, and writes a trailing newline.

Status reading checks process environment before the runtime env file, then runtime `.settings`, then the service default. `getRuntimeEnvPath(runtimeDirectory)` resolves the runtime env override file from `DOTENV_CONFIG_PATH` when set, otherwise `<runtimeDirectory>/.env`; this env file is never the service preference persistence target. Therefore `source: "environment"` means process env controls the effective value, `source: "runtime-env"` means the selected env file controls it, `source: "runtime-settings"` means `.settings` controls it, and `source: "default"` means no override was found. `persistedEnabled` reports the `.settings` value when one exists, even when env overrides make the effective value different. Status output includes env and settings paths without printing secrets.

Public enablement commands are:

```sh
dagent --runtime-directory <live-folder> services list
dagent --runtime-directory <live-folder> services status [opencode|telegram|calendar|api]
dagent --runtime-directory <live-folder> services enable <opencode|telegram|calendar|api>
dagent --runtime-directory <live-folder> services disable <opencode|telegram|calendar|api>
```

`services status` with no service prints all native enablement statuses. Telegram and Calendar may delegate to richer status; opencode and API print settings. `services status whatsapp` is a separate remote-only command and is not included in native list/enable/disable definitions.

If a service setting changes while `dagent start` is already running, the running supervisor is not reconfigured. Operators should restart the supervisor with `dagent stop` and `dagent start` after changing enablement.

## Rules

- Keep enable/disable commands side-effect-light; they must not start app services, OAuth, sync, Telegram polling, `opencode serve`, or WAHA.
- Keep service settings scoped to the selected runtime directory; do not write to the code repository unless it is explicitly selected as the runtime directory.
- Preserve process-env and runtime-`.env` override precedence in status output so active operator overrides are visible.
- Keep `.env` and `DOTENV_CONFIG_PATH` as environment/secret configuration and override sources, never as the service preference persistence target.
- Preserve canonical native service names `opencode`, `telegram`, `calendar`, and `api`.
- Keep `opencode` mapped to `OPENCODE_SERVER_AUTO_START`; do not conflate it with HTTP client usage of an already-running opencode server.
- Keep `telegram` mapped to `TELEGRAM_ENABLED`, defaulting to `true`; when disabled, startup must skip Telegram credential loading and must not create `TelegramConnectionService`.
- Keep `calendar` mapped to `GOOGLE_CALENDAR_ENABLED`, defaulting to `false`; Calendar OAuth remains a CLI operation, not startup behavior.
- Do not reintroduce `whatsapp` or `WHATSAPP_ENABLED`; Compose owns WAHA lifecycle.
- Keep `api` mapped to `DAGENT_API_ENABLED`, defaulting to `false`; API hostname, port, token, and endpoints are documented in `instruction/dagent-api.md`.
- Do not print or persist secrets from service status commands; enablement output contains env names, paths, booleans, sources, and descriptions only.
- Update CLI help, zsh completion, README operator notes, and this file when adding or renaming service toggles.

## Verification

Run static checks after service-setting code changes:

```sh
npm test
npm run typecheck
npm run build
```

After building, use a temporary runtime directory and non-startup CLI checks:

```sh
node dist/cli/src/cli.js help
node dist/cli/src/cli.js --help
node dist/cli/src/cli.js services --help
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services list
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services status telegram
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services status api
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services disable telegram
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services enable telegram
node dist/cli/src/cli.js completion zsh
```

Inspect `.settings` after enable/disable checks and confirm `.env` is unchanged. Do not run native startup or Compose/WAHA lifecycle operations during automated verification without approval.

The runtime service settings implementation was reported verified with `npm test`, `npm run typecheck`, `npm run build`, help/completion checks, `services` list/status/enable/disable checks against a temporary runtime directory, and no startup commands. The API toggle addition was reported verified with `services status api` against a temporary runtime directory and reports `DAGENT_API_ENABLED=false` from defaults.

## Child Instructions

| Instruction File | Description |
| --- | --- |
