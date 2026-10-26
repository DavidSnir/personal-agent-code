# Runtime Directory Instructions

## Scope

This file covers Personal Agent's runtime directory contract, relative path resolution, local generated files, and safe CLI checks when commands are launched from any current working directory.

## Context

This repository contains the agent logic. Runtime files belong in the user-selected live folder, called the runtime directory. Selection precedence is explicit `dagent -r <path>` or `dagent --runtime-directory <path>`, then `DAGENT_RUNTIME_DIRECTORY`, then the persistent user default, then the invocation current working directory. Once selected, runtime paths must be based on that directory rather than accidentally falling back to the installed code repository.

Standard Compose requires non-empty `HOME` and fixes its host runtime root at `${HOME}/.local/share/dagent`, rendered as `/Users/davidsnir/.local/share/dagent` here. Native CLI selection is separate: use an explicit flag or configure that absolute path persistently when intentionally operating on Compose data. The cwd fallback does not infer either `${HOME}/.local/share/dagent` or a `runtime/` child.

`dagent config runtime-directory` shows the configured and effective paths and their source. `--path <absolute-path>` stores a normalized absolute default, and `--clear` removes that default. The runtime-independent config is `${XDG_CONFIG_HOME:-$HOME/.config}/dagent/config.json`; it is not stored beneath any runtime. `shared/utils/userConfig.ts` writes atomically with the `dagent` directory at `0700` and file at `0600`. Setting a path does not create, validate, or migrate the selected runtime. Invalid or corrupt config fails clearly for commands that read it, while `--clear` can overwrite corrupt content to recover.

`shared/utils/runtimeDirectory.ts` exports `normalizeRuntimeDirectory(runtimeDirectory)`, `getDefaultRuntimeDirectory()`, `resolveRuntimePath(runtimeDirectory, path)`, `getRuntimeDataDirectory(runtimeDirectory)`, `getRuntimeServiceDataDirectory(runtimeDirectory, serviceName)`, `resolveRuntimeServiceDataPath(runtimeDirectory, serviceName, ...pathSegments)`, and `ensureRuntimeDirectoryStructure(runtimeDirectory, serviceNames)`. Absolute paths are preserved; relative paths resolve under the selected runtime directory. Service data defaults live under `<runtimeDirectory>/data/[service]`. Runtime service enablement settings are persisted in `<runtimeDirectory>/.settings` through `shared/utils/serviceSettings.ts`, not in `.env` or under `data/[service]`.

Important files:

- `shared/utils/runtimeDirectory.ts` defines runtime selection helpers, service data directory helpers, and `resolveRuntimePath()`.
- `shared/utils/userConfig.ts` validates and atomically persists the runtime-independent user default.
- `services/telegram/src/config.ts` loads `.env` from the selected runtime directory and resolves `DOTENV_CONFIG_PATH` and relative `OPENCODE_SERVER_DIRECTORY` values through `resolveRuntimePath()`.
- `shared/utils/serviceSettings.ts` reports native settings for opencode, Telegram, Calendar, and API; WhatsApp has no native toggle.
- `services/telegram/src/telegram/credentials.ts` stores Telegram credentials under the selected runtime directory's Telegram service data directory.
- `services/calendar/src/google/config.ts` loads `.env` from the selected runtime directory, defaults Calendar SQLite to the Google Calendar service data directory, and resolves explicit `GOOGLE_CALENDAR_DB_PATH`, `GOOGLE_CALENDAR_CREDENTIALS_PATH`, and CLI `--credentials-file` paths through `resolveRuntimePath()`.
- `services/whatsapp/src/whatsapp/config.ts` loads `.env` and defaults WhatsApp SQLite under the selected runtime directory.
- `cli/src/cli.ts` parses global `-r`/`--runtime-directory`, prints both `runtimeDirectory` and diagnostic `currentDirectory` in help output, implements `dagent services init`, starts/stops the detached supervisor through runtime-local pid/log files, and routes service-specific commands through the same resolved paths.
- `services/calendar/src/google/repository.ts` reports `runtimeDirectory`, `currentDirectory`, and absolute `dbPath` in status JSON.
- `services/agent/src/opencode/runtimeConfig.ts` installs Calendar and WhatsApp MCP entries in `<runtimeDirectory>/opencode.json`.
- `<runtimeDirectory>/opencode.json` launches MCP servers with `dagent services mcp calendar` and `dagent services mcp whatsapp`; both entries set `environment.DAGENT_RUNTIME_DIRECTORY` to the selected runtime directory so opencode-launched processes use the selected live folder for local files.

Path behavior:

- Runtime selection order is `--runtime-directory`/`-r` when CLI parsing applies, then `DAGENT_RUNTIME_DIRECTORY`, then persistent user config, then `process.cwd()`.
- App startup without an explicit CLI flag uses `DAGENT_RUNTIME_DIRECTORY`, then persistent user config, then `process.cwd()`.
- Default `.env` is `<runtimeDirectory>/.env` after runtime selection.
- Default `.settings` is `<runtimeDirectory>/.settings` after runtime selection.
- Relative `DOTENV_CONFIG_PATH` values resolve from the runtime directory.
- `dagent services enable <service>` and `dagent services disable <service>` write to `<runtimeDirectory>/.settings` and create the runtime directory if needed; `DOTENV_CONFIG_PATH` is not a persistence target.
- `dagent services list` and `dagent services status [service]` report process-environment overrides before runtime `.env` values, then `.settings`, then defaults; process env or `.env` overrides can make effective status differ from the persisted `.settings` value.
- Runtime service data belongs under `<runtimeDirectory>/data/[service]`; use kebab-case service names accepted by `assertServiceName()`.
- The Telegram service data directory is `<runtimeDirectory>/data/telegram`.
- Telegram credential auth stores `<runtimeDirectory>/data/telegram/credentials.json`; status reports only path and presence booleans.
- Under the Compose host root, Telegram credentials are `${HOME}/.local/share/dagent/data/telegram/credentials.json` and its optional env file is `${HOME}/.local/share/dagent/data/telegram/.env`.
- The Google Calendar service data directory is `<runtimeDirectory>/data/google-calendar`.
- The WhatsApp service data directory is `<runtimeDirectory>/data/whatsapp`.
- The DAgent CLI lifecycle service data directory is `<runtimeDirectory>/data/dagent`; detached starts write `<runtimeDirectory>/data/dagent/dagent.pid` and append app stdout/stderr to `<runtimeDirectory>/data/dagent/dagent.log`.
- `GOOGLE_CALENDAR_DB_PATH` defaults to `<runtimeDirectory>/data/google-calendar/google-calendar.sqlite`.
- Explicit absolute `GOOGLE_CALENDAR_DB_PATH` values are allowed for operator overrides or migrations and bypass runtime-directory joining.
- Relative `GOOGLE_CALENDAR_DB_PATH` values resolve from the runtime directory; prefer defaults or paths inside `data/[service]` for new service SQLite databases.
- Relative `GOOGLE_CALENDAR_CREDENTIALS_PATH` and `dagent services auth|sync|status calendar --credentials-file <path>` values resolve from the runtime directory. Use an absolute credentials path for files stored elsewhere.
- `WHATSAPP_DB_PATH` defaults to `<runtimeDirectory>/data/whatsapp/whatsapp.sqlite`; explicit absolute overrides are supported and relative overrides resolve from the runtime directory.
- Standard Compose persists WAHA session state at `${HOME}/.local/share/dagent/data/whatsapp/waha-sessions:/app/.sessions`; no current `WHATSAPP_SESSION_PATH` setting exists.
- Standard Compose persists OpenCode provider data and auth at `${HOME}/.local/share/dagent/data/opencode:/root/.local/share/opencode`.
- Standard Compose uses root `${HOME}/.local/share/dagent/opencode.json`; the agent reads it at `/runtime/opencode.json`, while control-api updates that same host file at `/agent-runtime/opencode.json`.
- `OPENCODE_SERVER_DIRECTORY` defaults to the absolute path `/Users/davidsnir/ai-projects/personal-agent`; relative overrides resolve from the selected runtime directory.
- `OPENCODE_DIRECTORY` is preserved as configured and sent to opencode as the request `directory` query parameter; do not silently change its resolution semantics.

`dagent services init` prepares native local data and local/default MCP config without starting Telegram, opencode, OAuth, WAHA, or live sync. `dagent services init compose` is the canonical deployment initializer: it creates all narrow bind sources with private modes, initializes canonical Calendar and WhatsApp DB paths regardless of DB-path env overrides, and installs both exact remote MCP entries in root `opencode.json`. It does not create or reconcile a WAHA session. Top-level `dagent init` remains a compatibility spelling for native initialization.

Runtime-safe local commands include Telegram/Calendar status, native service list/toggles, shared init, and database-only MCP. WhatsApp `init|auth|sync|logout|status` require control-api and are not local runtime-safe commands. `dagent start`/`stop` use `data/dagent`; no WhatsApp pid/log path exists.

## Rules

- Do not use the installed code repository as an implicit runtime location.
- Use `process.cwd()` only as the final default after env and persistent config; after selection, pass `runtimeDirectory` explicitly and resolve local files from it.
- Keep user config runtime-independent, require normalized absolute paths, preserve atomic `0700`/`0600` writes, and never create or migrate a selected runtime while configuring it.
- Use `resolveRuntimePath(runtimeDirectory, path)` for new project-local runtime file paths unless a verified external absolute path is required.
- Use `getRuntimeServiceDataDirectory(runtimeDirectory, serviceName)` or `resolveRuntimeServiceDataPath(runtimeDirectory, serviceName, ...)` for default service data and SQLite database locations.
- Put each service's default local SQLite files under `<runtimeDirectory>/data/[service]`; do not add new defaults directly under `data/`.
- Keep `currentDirectory` in status output diagnostic only; it must not drive DB or credentials path selection.
- Keep generated runtime paths ignored and never commit SQLite, OAuth, credentials, WAHA sessions, pid/log, or cache contents.
- For commands intended to share Compose state, pass `--runtime-directory "${HOME}/.local/share/dagent"`; other explicit CLI runtime roots remain valid.
- Keep standard Compose's non-empty `HOME` requirement, narrow binds, and `create_host_path: false`; initialize sources explicitly instead of relying on Docker directory creation.
- Do not add implicit compatibility lookups for old repository-relative paths. Migrate only while services are stopped, check destination conflicts first, preserve ownership and modes (including Telegram credentials at `0600`), and never inspect or print secret contents.
- Preserve the default opencode server cwd `/Users/davidsnir/ai-projects/personal-agent` unless the user explicitly requests a different target project.
- Do not touch unrelated files in a selected live folder; create only the runtime files that the command under test is expected to create.
- Preserve `OPENCODE_DIRECTORY` behavior when changing runtime directory logic; it is distinct from local DB and MCP file resolution.
- Document any new relative path setting with its base directory and whether absolute paths bypass runtime resolution.
- Keep service enable/disable persistence in the selected runtime `.settings` file, never in `.env` or generated `data/` directories.
- Keep WhatsApp runtime data isolated under `<runtimeDirectory>/data/whatsapp`; do not mix it with `data/dagent`, Telegram credentials, or Calendar cache files.
- Do not run startup commands during automated verification unless the user explicitly approves opencode, Telegram, Calendar, and WhatsApp side effects.

## Verification

Run static checks after runtime path or CLI changes:

```sh
npm run typecheck
npm run build
npm run build:calendar
npm run build:cli-api
npm run build:whatsapp
node -e "import('./dist/shared/utils/runtimeDirectory.js').then((m) => { if (typeof m.getDefaultRuntimeDirectory !== 'function') throw new Error('getDefaultRuntimeDirectory export missing'); })"
node -e "Promise.all([import('./dist/services/calendar/src/google/config.js'), import('./dist/services/whatsapp/src/whatsapp/config.js')])"
```

`dist/` is generated and ignored by git, so a source export can be correct while stale compiled output still crashes a container. When a runtime helper import/export mismatch is reported from compiled files, rebuild the relevant service output instead of editing `dist/`, then verify the generated ESM imports directly before declaring the crash fixed. For container-only import/export mismatches, also verify the service Dockerfile copies the root `package.json` next to root `tsconfig.json` before its service-scoped build so TypeScript NodeNext compiles shared helpers under the repository ESM package scope.

Run non-startup CLI checks after building:

```sh
node dist/cli/src/cli.js help
node dist/cli/src/cli.js --help
node dist/cli/src/cli.js services --help
node dist/cli/src/cli.js completion zsh
XDG_CONFIG_HOME=/tmp/dagent-config-test node dist/cli/src/cli.js config runtime-directory
XDG_CONFIG_HOME=/tmp/dagent-config-test node dist/cli/src/cli.js config runtime-directory --path /tmp/personal-agent-runtime-test
XDG_CONFIG_HOME=/tmp/dagent-config-test node dist/cli/src/cli.js config runtime-directory --clear
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services list
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services status telegram
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services disable telegram
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services enable telegram
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services init
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services auth telegram --bot-token "fake-test-token" --user-id "123456"
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services status telegram
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services status calendar
```

For the Compose-backed Telegram path, a safe status check is:

```sh
dagent --runtime-directory "${HOME}/.local/share/dagent" services status telegram
```

Confirm only the reported runtime path and configured/presence booleans; never copy credential values into logs or documentation.

For an approved migration from the former repository-relative root, stop affected services, ensure the destination has no conflicts, and use a metadata-preserving copy such as `rsync -a ./runtime/ "${HOME}/.local/share/dagent/"`. Verify ownership, permissions, and non-secret path presence without reading secret contents; retain the source until verification succeeds. Recreate affected Compose services afterward because restart alone retains old bind mounts. Do not perform migration or recreation as documentation verification.

Verify runtime selection from a different directory by invoking the built CLI with an absolute path. Without `--runtime-directory`, `runtimeDirectory` should be that cwd. With `--runtime-directory <live-folder>`, `runtimeDirectory`, DB paths, and `opencodeConfig.configPath` should point under the selected live folder, while `currentDirectory` reports the alternate directory:

```sh
node /Users/davidsnir/ai-projects/personal-agent-code/dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services status calendar
```

The full post-migration remediation was reported verified on 2026-07-22 with 82 tests, typecheck, full and service builds, targeted images, Compose rendering, an empty-`HOME` negative check, and live canonical service recreation. See `instruction/compose-runtime.md` for the non-secret migration record and the unresolved WhatsApp QR re-pair requirement.

## Child Instructions

| Instruction File | Description |
| --- | --- |
