# Telegram Credential Gateway Instructions

## Scope

This file covers the Telegram service credential gateway for Personal Agent: CLI auth/status commands, runtime credential storage, startup loading, env override precedence, and secret-handling rules.

## Context

Telegram credentials are no longer only required through `.env`. Operators should normally run the compiled CLI to store the Telegram bot token and owner user ID in the selected runtime directory before startup:

```sh
dagent --runtime-directory <live-folder> services auth telegram --bot-token <token> --user-id <numeric-id>
dagent --runtime-directory <live-folder> services status telegram
```

To operate on the standard Compose host runtime, `<live-folder>` is `${HOME}/.local/share/dagent`:

```sh
dagent --runtime-directory "${HOME}/.local/share/dagent" services auth telegram --bot-token <token> --user-id <numeric-id>
dagent --runtime-directory "${HOME}/.local/share/dagent" services status telegram
```

The runtime directory follows the shared selection rules documented in `instruction/runtime-directory.md`: explicit `-r`/`--runtime-directory` wins, then `DAGENT_RUNTIME_DIRECTORY`, then the persistent user default, then invocation cwd. `services/telegram/src/telegram/credentials.ts` uses service name `telegram` and stores credentials at `<runtimeDirectory>/data/telegram/credentials.json`. The JSON file contains `botToken`, `allowedUserId`, and `updatedAt`; the file is written with mode `0600` and the service directory is created when auth runs. Telegram can be disabled with `TELEGRAM_ENABLED=false` or `dagent --runtime-directory <live-folder> services disable telegram`; disabled startup skips credential loading entirely.

With `--runtime-directory "${HOME}/.local/share/dagent"`, the Compose-backed host credential path is `${HOME}/.local/share/dagent/data/telegram/credentials.json`. Standard Compose exposes that same file to Telegram at `/runtime/data/telegram/credentials.json` and to control-api at `/telegram-runtime/data/telegram/credentials.json`; both containers still use the unchanged `<runtimeDirectory>/data/telegram/credentials.json` contract. The optional env-based credential file is `${HOME}/.local/share/dagent/data/telegram/.env`, injected by Compose as process environment rather than loaded from `/runtime/.env`.

For migration from repository-relative runtime roots, stop affected services, check that `${HOME}/.local/share/dagent` destinations do not conflict, and copy with ownership and modes preserved; Telegram credentials must remain `0600`. Never read or print credential contents, overwrite conflicts, or remove the source before verification. There is no automatic fallback to former paths.

Important files:

- `services/telegram/src/telegram/credentials.ts` validates, persists, loads, and reports Telegram credentials.
- `cli/src/cli.ts` implements `dagent services auth telegram`, `dagent services status telegram`, and the `dagent services enable|disable telegram` commands that can write `TELEGRAM_ENABLED`.
- `services/telegram/src/config.ts` loads effective Telegram credentials during non-interactive startup only when Telegram is enabled.
- `services/telegram/src/app.ts` passes the effective token and allowed user ID into `TelegramConnectionService`.
- `services/telegram/src/telegram/telegramConnectionService.ts` uses the token only for Bot API calls and authorizes by numeric `message.from.id` before all work.

Credential precedence during startup is intentionally simple when Telegram is enabled. `TELEGRAM_ENABLED` defaults to `true`. If it is `false`, `services/telegram/src/config.ts` does not load env or persisted Telegram credentials and `services/telegram/src/app.ts` does not create `TelegramConnectionService`. If Telegram is enabled and both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USER_ID` are set in the runtime `.env` or process environment, both env values are used. If either env value is missing, persisted credentials are loaded and env may override one side while persisted credentials fill the missing side. If the effective bot token or numeric user ID is still missing while Telegram is enabled, startup throws a helpful non-interactive error telling the operator to run `dagent --runtime-directory <runtimeDirectory> services auth telegram --bot-token <token> --user-id <numeric-id>` or set both env variables.

`dagent services status telegram` loads the runtime `.env` and persisted credentials, then prints only non-secret JSON: `runtimeDirectory`, `currentDirectory`, `credentialsPath`, env presence booleans, persisted presence booleans plus `updatedAt`, and effective configured booleans. It must not print the bot token or user ID value. `dagent services auth telegram` validates `--bot-token` as a non-empty string, validates `--user-id` as a positive safe numeric Telegram user ID, stores credentials, and prints the credentials path plus non-secret presence messages.

## Rules

- Never print, log, commit, or include the Telegram bot token in status output.
- Keep Telegram startup non-interactive; operators must auth before startup unless Telegram is explicitly disabled.
- Preserve `TELEGRAM_ENABLED=false` as a startup path that does not require Telegram credentials and does not read persisted credential files.
- Keep `allowedUserId` numeric and positive; never use Telegram usernames for access control.
- Preserve env overrides for operators who prefer `.env` or process environment secrets.
- Preserve persisted credential fallback when env values are absent or partial.
- Keep the default credential path under `<runtimeDirectory>/data/telegram/credentials.json`.
- Use `--runtime-directory "${HOME}/.local/share/dagent"` only when native commands intentionally share Compose data; arbitrary explicit CLI roots remain supported.
- Keep `dagent services init` creating `<runtimeDirectory>/data/telegram/` without requiring Telegram credentials.
- Treat `<runtimeDirectory>/data/telegram/credentials.json` as local secret data.
- Preserve credential ownership and mode `0600` during manual path migrations; stop on destination conflicts instead of overwriting.
- Do not add token values to README examples, instruction prose, errors, or logs.
- Keep the removed top-level `telegram` command group removed unless compatibility is explicitly requested.

## Verification

Run static checks after credential gateway changes:

```sh
npm run typecheck
npm run build
```

After building, run non-startup CLI checks in a temporary runtime directory:

```sh
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services init
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services status telegram
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services auth telegram --bot-token "fake-test-token" --user-id "123456"
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services status telegram
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services disable telegram
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services status telegram
node dist/cli/src/cli.js --runtime-directory /tmp/personal-agent-runtime-test services enable telegram
```

Expected CLI behavior: the first status reports `effective.configured: false` when no env or persisted credentials exist; auth creates `<runtimeDirectory>/data/telegram/credentials.json`; the second status reports token and user ID presence booleans without printing the token; service disable/enable writes `TELEGRAM_ENABLED=false` or `true` to the selected runtime `.settings` file. Do not run `dagent start`, `DAgent start`, `node dist/cli/src/cli.js start`, or `npm start` during automated verification unless the user approves Telegram polling, opencode, Calendar, and WhatsApp side effects.

The CLI services reorganization was reported verified with runtime init, Telegram status before and after fake credential auth, service disable/enable checks, and no startup commands.

For the Compose-backed credential, `dagent --runtime-directory "${HOME}/.local/share/dagent" services status telegram` may verify path and effective presence without exposing values. The 2026-07-22 remediation migrated the canonical layout and recreated services; future mount edits still require recreation, and credential contents must remain uninspected.

## Child Instructions

| Instruction File | Description |
| --- | --- |
