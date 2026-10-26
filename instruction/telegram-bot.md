# Telegram Bot Instructions

## Scope

This file covers Telegram Bot API behavior implemented in `services/telegram/src/telegram/telegramConnectionService.ts`, including long polling, owner-only access control, commands, chat-session mapping, and reply delivery. Credential persistence and CLI auth details live in `instruction/telegram-credentials.md`.

## Context

The bot talks directly to `https://api.telegram.org/bot<TOKEN>` using Node's built-in `fetch`; no Telegram SDK is currently used. Telegram is enabled by default through `TELEGRAM_ENABLED=true`. When `TELEGRAM_ENABLED=false`, `services/telegram/src/app.ts` logs that Telegram is disabled and does not construct `TelegramConnectionService`, so no credentials are loaded and no long polling starts. The Docker Telegram service bypasses the multi-service app and uses `services/telegram/src/telegramIndex.ts -> runTelegramService()`, which loads config with `forceTelegramEnabled: true` and constructs only `TelegramConnectionService`. When enabled or forced, `TelegramConnectionService.start()` starts a background long-polling loop with `getUpdates`, `timeout: 30`, and `allowed_updates: ["message", "callback_query"]`. The app or Telegram-only runner passes a fatal handler into `TelegramConnectionService`, and `start()` supervises the polling promise: unexpected resolution or rejection while not stopping is routed to that fatal handler. `stop()` aborts the current poll or retry delay for graceful shutdown, catches a polling rejection that is already being handled as fatal, and still completes service cleanup.

Each received update advances the in-memory `offset` to at least `update_id + 1` before its message or callback handler runs. A failed update is therefore acknowledged by the next `getUpdates` request instead of becoming a poison update that is handled repeatedly. Update-handler failures are caught independently from polling failures, logged with sanitized error text, and do not trigger polling backoff.

Recoverable `getUpdates` failures use bounded exponential backoff based on consecutive failed polls: 1 second, 2 seconds, 4 seconds, 8 seconds, 16 seconds, then 30 seconds for the sixth and every later consecutive failure. Any successful `getUpdates` response, including an empty update list, resets the failure count so the next failure waits 1 second. Logs identify the retry delay and attempt and extract nested network codes such as `EAI_AGAIN` and `UND_ERR_CONNECT_TIMEOUT` from an error and its `cause` chain. Log and user-facing error summaries redact the configured token and Bot API URL credentials and normalize whitespace. Unrecoverable Bot API `getUpdates` failures with status or `error_code` `401`, `403`, `404`, or `409` bypass retry, throw out of the polling loop, and become fatal app errors.

When message handling fails, the service logs the original sanitized error and attempts a plain-text `Error: ...` reply. Failure of that `sendMessage` call is caught and logged separately, so it cannot mask the original update error or escape into `getUpdates` retry handling. Callback handling follows the same isolation rule for a failed `answerCallbackQuery` error report. An outer per-update catch remains a final boundary around update dispatch.

Access control is based on the effective Telegram allowed user ID loaded by `services/telegram/src/config.ts` from either env overrides or persisted runtime credentials and passed into `TelegramConnectionService` from `services/telegram/src/app.ts` or `services/telegram/src/telegramService.ts`. The value must be a positive safe integer matching the owner's Telegram `message.from.id` or callback-query `from.id`. `services/telegram/src/telegram/telegramConnectionService.ts` checks the sender before command handling, session creation, health checks, model changes, or agent message forwarding. Missing or mismatched message `from.id` receives exactly `Access denied.` in the message chat and returns without touching agent state; unauthorized callbacks are answered with `Access denied.`.

Implemented commands:

- `/start` sends a short readiness and usage message.
- `/health` calls the configured agent health check and reports `displayName healthy: <boolean>` plus `version` when present.
- `/new` creates a fresh agent session for the Telegram chat, stores it, and includes the agent display name in the reply.
- `/model` sends an indexed numbered list of available opencode model IDs with inline keyboard buttons. Tapping a button or sending `/model <number>` sets the selected model and updates the message in place. The list includes all models from connected opencode providers. Sending `/model <provider/model>` also works for direct text selection.
- `/model <provider/model>` or `/model <number>` validates and sets the selected opencode model for later forwarded messages in the running process; the keyboard-based list message is updated when a model is selected via button.
- Other slash commands receive an unknown-command message.
- Any non-command text is sent to the current chat session, creating one first when needed.

For an authorized ordinary non-command message in a `private`, `group`, or `supergroup` chat, handling immediately calls the raw Bot API method `sendChatAction` with exactly `{ chat_id: chatId, action: "typing" }` before session creation or agent work. One sequential abortable loop waits 4000 milliseconds between refreshes and awaits each action before starting the next delay, so action calls never overlap. Typing maintenance is stopped and fully awaited in a `finally` block before the persistent AI reply or existing handler error response. Initial action, refresh, and delay failures are sanitized, logged, and otherwise ignored. Commands, empty messages, unauthorized messages, and channel messages do not start typing. No draft API is used alongside this action. This Telegram-only waiting state does not consume or expose opencode reasoning.

Chat state is `Map<number, string>` where the key is Telegram `chat.id` and the value is an agent session ID. This state is process-local memory, so restarting the bot clears all chat-to-session mappings.

Every Telegram-to-opencode HTTP call is bounded by `OPENCODE_REQUEST_TIMEOUT_MS`, default `120000` and maximum `600000`. The adapter uses `AbortSignal`; timeout and transport errors are actionable, sanitized, and truncated before entering Telegram's existing handler-error boundary.

Replies are sent with the raw Bot API `sendMessage` method. Command replies, access-denied replies, health output, unknown-command replies, `/new` session replies, `/model` model-list/set replies, and handler error replies are sent as plain text without a Telegram `parse_mode`.

Only AI/opencode answers from ordinary non-command text forwarding are sent with Telegram `parse_mode: "Markdown"`. The opencode-backed agent returns `format: "markdown"`, and the Telegram service maps that to Telegram's legacy Markdown parse mode rather than MarkdownV2 or HTML.

Because Telegram messages are limited to 4096 characters, `splitTelegramMessage()` sends long outgoing responses in 4096-character chunks. When an opencode answer is chunked, each chunk is sent with the same Markdown parse mode; plain-text bot replies remain unformatted.

## Rules

- Do not log or expose the Telegram bot token.
- Keep the effective allowed user ID required and numeric; do not authorize by Telegram username.
- Keep Telegram credential loading non-interactive during startup; use CLI auth beforehand.
- Preserve `TELEGRAM_ENABLED=false` as an opt-out that skips credential loading and Telegram long polling.
- Perform authorization before commands, agent health checks, session creation, and message forwarding.
- Preserve the unauthorized response text `Access denied.` unless the user asks to change it.
- Preserve long polling unless the user explicitly asks for webhooks.
- Keep background polling supervised through `onFatal`; never leave an unhandled polling promise outside app shutdown.
- Treat `getUpdates` `401`, `403`, `404`, and `409` as unrecoverable so invalid credentials, forbidden bots, missing endpoints, or polling conflicts stop the app.
- Keep recoverable polling backoff at 1s, 2s, 4s, 8s, 16s, then a 30s cap, and reset it after every successful poll.
- Keep `stop()` tolerant of polling rejection and abort both an active long poll and an active backoff delay so reverse-order shutdown remains responsive.
- Advance the offset before dispatching each update; processing failures must not create poison-update loops.
- Keep update and callback error-report sends isolated; reporting failure must not replace the original error or enter polling retry handling.
- Sanitize every logged or chat-visible error summary. Preserve nested network error codes while redacting both literal tokens and credentials embedded in Telegram Bot API URLs.
- Keep per-chat agent sessions isolated by Telegram `chat.id`.
- Treat in-memory sessions as non-durable unless persistent storage is intentionally added.
- Keep `/model` authorization-gated like every other command, and keep model selection process-local unless persistent model storage is intentionally added.
- Continue chunking outgoing Telegram messages at or below 4096 characters.
- Preserve Markdown formatting for AI/opencode answers unless the user asks otherwise.
- Do not apply Markdown parse mode to commands, access-denied, health, `/new`, `/model`, unknown-command, or error replies unless intentionally changing those user-facing messages.
- Surface handler errors to the chat as readable error text, but avoid including secrets.
- Keep opencode requests bounded by validated `OPENCODE_REQUEST_TIMEOUT_MS`; preserve auth/token redaction in downstream errors.
- Keep typing actions best-effort, sequential, non-overlapping, abortable, and independent from the opencode request contract or reasoning stream.
- Start typing only after authorization and empty/command returns for ordinary private, group, and supergroup messages; exclude channels.
- Stop and await typing maintenance in `finally` before persistent success/error delivery and during serialized shutdown.

## Verification

Run TypeScript checks after changes:

```sh
npm run typecheck
npm run build
```

For Telegram polling and error-boundary changes, build the Telegram output before running the focused test because the test imports compiled code from `dist/`:

```sh
npm run build:telegram
npx tsc -p services/telegram/tsconfig.json --noEmit
node --test test/telegramConnectionService.test.mjs
git diff --check
```

The focused test covers nested DNS/connect-timeout codes, retry sequence/cap/reset, token redaction, failed update reporting, offset safety, fatal `401`/`403`/`404`/`409`, shutdown during retry, typing lifecycle and refresh cancellation, failure isolation, cleanup ordering, and private/group/supergroup/command/authorization/channel gating. `test/opencodeModel.test.mjs` additionally covers bounded Telegram-to-opencode requests and secret-safe timeout guidance.

Verification reported for this implementation on 2026-07-22: `npm run build:telegram`, Telegram `tsc --noEmit`, the focused 7/7 test file, the aggregate 85/85 test suite, typecheck, full build, and `git diff --check` passed. No live Telegram test was run, so native client display and timing still require the manual check below.

Avoid startup commands in automated checks unless the user approves Telegram and opencode side effects. For manual failure testing, verify transient fetch errors do not invoke `onFatal`, retry timing resets after connectivity returns, logs contain useful network codes but no token, and shutdown interrupts either an active `getUpdates` request or retry delay. Also verify fatal polling statuses still reach `onFatal` without retry.

Manual runtime checks require a real Telegram bot token, a persisted or env-configured numeric owner user ID, and network access to Telegram. Prefer `dagent --runtime-directory <live-folder> services auth telegram --bot-token <token> --user-id <numeric-id>` before startup. Start the bot and verify `/start`, `/health`, `/new`, `/model`, `/model <provider/model>`, an unknown slash command, and ordinary text forwarding from the allowed user. For a slow ordinary message, verify Telegram shows typing immediately and refreshes it while waiting in private, group, and supergroup chats, then stops before the persistent answer; verify commands, unauthorized messages, and channels show no typing action. For ordinary text forwarding, use or request an AI answer containing Markdown such as bold text, lists, code, or links and verify Telegram renders it instead of showing only raw markup. Also verify command, access-denied, health, `/new`, `/model`, unknown-command, and error replies remain acceptable as plain text, and that a different Telegram user receives `Access denied.` without creating or reusing opencode sessions or changing the selected model.

## Child Instructions

| Instruction File | Description |
| --- | --- |
| instruction/telegram-credentials.md | Telegram credential persistence, CLI auth, and startup loading. |
