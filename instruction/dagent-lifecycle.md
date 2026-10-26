# DAgent Detached Lifecycle Instructions

## Scope

This file covers the operator lifecycle for starting and stopping the Personal Agent supervisor with the compiled `dagent`/`DAgent` CLI. It documents the detached background process, runtime-local pid/log files, enabled-service startup semantics, shutdown behavior, and safe verification rules.

## Context

Personal Agent has two startup paths that must stay distinct. `npm start` runs `node dist/services/telegram/src/index.js`, which executes `services/telegram/src/index.ts -> runApp()` in the foreground. The operator CLI command `dagent start` runs through `cli/src/cli.ts` and starts the same app in a detached background child so the invoking terminal is released. `DAgent start` is also available through the uppercase bin, but lowercase `dagent` is preferred in new examples.

The legacy `dagent agent start` and `dagent agent stop` command group has been removed and should keep failing with `Unknown command:`. Do not document or restore it as an alias unless the user explicitly requests compatibility.

Runtime directory selection happens before lifecycle commands run: explicit `-r`/`--runtime-directory` wins, then `DAGENT_RUNTIME_DIRECTORY`, then the persistent user default, then invocation cwd. The selected runtime directory is passed to the detached child both as `--runtime-directory <path>` and as `DAGENT_RUNTIME_DIRECTORY=<path>`. Runtime data for this lifecycle lives under `<runtimeDirectory>/data/dagent`.

Important implementation details:

- `cli/src/cli.ts` owns the public `start` and `stop` commands.
- `cli/src/cli.ts` uses a private `__run-detached-app` command for the spawned child; do not treat it as an operator-facing command.
- `dagent start` appends a start marker and all child stdout/stderr to `<runtimeDirectory>/data/dagent/dagent.log`.
- `dagent start` prints concise status only: background notice, pid, log path, and matching stop command.
- The detached child writes `<runtimeDirectory>/data/dagent/dagent.pid` before calling `runApp({ runtimeDirectory })`.
- The pid file is JSON with `pid`, `runtimeDirectory`, `logPath`, and `startedAt` fields.
- `dagent stop` reads the selected runtime directory's pid file, sends `SIGTERM`, and waits up to 10 seconds for the process to exit.
- On normal child exit, the child removes the pid file only when it still belongs to the current process.
- `services/telegram/src/app.ts` handles `SIGTERM` by stopping successfully started services in reverse order.

`dagent start` starts native services selected by `OPENCODE_SERVER_AUTO_START`, `TELEGRAM_ENABLED`, `GOOGLE_CALENDAR_ENABLED`, and `DAGENT_API_ENABLED`. WhatsApp is not part of this supervisor; Compose owns WAHA and control-api. Changing a native toggle while running does not live-reconfigure the process.

Start command behavior is intentionally conservative. If a valid pid file points at a running process, start refuses to launch another detached supervisor and prints the existing pid and log path. If the pid file is invalid or points at a dead process, start removes it before spawning a new child. Stop removes invalid or stale pid files without signaling unrelated processes.

The native and detached WhatsApp worker paths were removed. `dagent services start|stop whatsapp` must remain unavailable; use Docker Compose to manage `waha`, `control-api`, and `whatsapp-mcp`.

When `DAGENT_CLI_API_URL` or stored runtime CLI API configuration is effective, `dagent start`, `dagent stop`, and private `__run-detached-app` execution must fail before any API request or local spawn. This protects the canonical Compose deployment from a second native supervisor. Operators must clear the API URL intentionally before returning to native lifecycle management.

## Rules

- Preserve `npm start` and `services/telegram/src/index.ts -> runApp()` as foreground app startup paths.
- Keep `dagent start` detached; it must not stream the app log to the invoking terminal.
- Keep detached stdout/stderr appended to `<runtimeDirectory>/data/dagent/dagent.log`.
- Keep pid tracking at `<runtimeDirectory>/data/dagent/dagent.pid` and scoped to the selected runtime directory.
- Always pass the selected runtime directory into the detached child explicitly.
- Do not expose `__run-detached-app` as documented human CLI surface.
- Reject all native lifecycle and private detached commands while a CLI API URL is configured; never proxy them through control-api.
- Keep the removed `agent` command group removed unless compatibility is explicitly requested.
- Do not introduce automated startup verification unless the user explicitly approves opencode, Telegram, Calendar, and WhatsApp side effects.
- When changing stop behavior, preserve graceful `SIGTERM` shutdown through `runApp()` so managed services clean up.
- Treat pid and log files as local runtime output; do not commit files under runtime `data/dagent/`.

## Verification

Run static checks after CLI lifecycle changes:

```sh
npm run typecheck
npm run build
```

Run non-startup CLI checks after building:

```sh
node dist/cli/src/cli.js help
node dist/cli/src/cli.js --help
node dist/cli/src/cli.js completion zsh
node dist/cli/src/cli.js start --help
node dist/cli/src/cli.js stop --help
node dist/cli/src/cli.js services --help
```

Use runtime-safe commands to confirm runtime directory selection without starting the app:

```sh
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services init
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services status telegram
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services status calendar
```

Do not run native startup or `docker compose up` during automated verification unless the user approves local opencode, Telegram, Calendar, API, and WAHA side effects. With approval for a native run, use the selected live folder and stop it with the matching `dagent stop`; manage WhatsApp separately through Compose.

The 2026-07-22 remediation verified the API-mode lifecycle rejection in automated tests and confirmed no duplicate native services during live Compose validation.

## Child Instructions

| Instruction File | Description |
| --- | --- |
