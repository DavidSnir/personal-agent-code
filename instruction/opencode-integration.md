# Opencode Integration Instructions

## Scope

This file covers the local `opencode serve` process management in `services/telegram/src/telegram/opencodeServerService.ts`, opencode HTTP clients used by Telegram and other app paths, configuration from `services/telegram/src/config.ts`, and opencode project configuration that affects this app.

## Context

The app expects a local opencode HTTP server when Telegram forwarding or another opencode client path is used. With `OPENCODE_SERVER_AUTO_START=true`, `OpencodeServerService` starts `opencode serve --port 4096 --hostname 127.0.0.1 --print-logs` from `/Users/davidsnir/ai-projects/personal-agent`, polls `GET /global/health` until it is ready or a 30-second deadline passes, treats early startup exit as a startup failure, treats unexpected later exit as fatal, and stops the child process during app shutdown. App shutdown includes `SIGINT`, `SIGTERM`, startup failure after opencode started, unexpected managed opencode exit, and fatal Telegram polling failures routed through `runApp()`. Opencode HTTP clients normalize `OPENCODE_SERVER_URL` by removing trailing slashes and use built-in `fetch` for requests. This opencode server cwd is separate from the Personal Agent runtime directory, although an operator may choose the same folder for both.

When `OPENCODE_SERVER_AUTO_START=false`, `services/telegram/src/app.ts` does not construct `OpencodeServerService` and logs that it expects an existing server. Disabling opencode auto-start does not disable opencode HTTP client usage; Telegram forwarding still needs a reachable `OPENCODE_SERVER_URL` when Telegram is enabled.

The selected runtime `opencode.json` can register local stdio Calendar and WhatsApp MCP commands. Standard Compose uses canonical host root `opencode.json`; the agent reads that exact file read-only at `/runtime/opencode.json` because `OPENCODE_CONFIG` points there, while `control-api` updates it at `/agent-runtime/opencode.json`. Compose installs remote Calendar at `http://calendar-mcp:7332/mcp` and remote database-only WhatsApp at `http://whatsapp-mcp:7333/mcp`. Installation preserves unrelated valid fields. Local entries set `DAGENT_RUNTIME_DIRECTORY` so SQLite and credentials remain cwd-independent; WAHA session storage is Compose-owned and is not used by the local MCP process.

The local MCP config shapes are `mcp.calendar = { type: "local", command: ["dagent", "services", "mcp", "calendar"], environment: { DAGENT_RUNTIME_DIRECTORY: "<runtimeDirectory>" }, enabled: true }` and `mcp.whatsapp = { type: "local", command: ["dagent", "services", "mcp", "whatsapp"], environment: { DAGENT_RUNTIME_DIRECTORY: "<runtimeDirectory>" }, enabled: true }`. The standard compose remote shapes are `mcp.calendar = { type: "remote", url: "http://calendar-mcp:7332/mcp", enabled: true }` and `mcp.whatsapp = { type: "remote", url: "http://whatsapp-mcp:7333/mcp", enabled: true }`. `$schema` is always set to `https://opencode.ai/config.json`. The installer creates `<runtimeDirectory>/opencode.json` if missing, overwrites only requested MCP entries when needed, and throws if the existing top-level `mcp` field is not a JSON object.

`dagent services init compose` creates the canonical config at mode `0600` and installs both exact remote entries regardless of ambient MCP transport variables. `POST /deployment/init` performs the same safe config update through control-api and may restart the agent after exact path verification.

The root-run agent image persists OpenCode's own provider registry/auth data through host `${HOME}/.local/share/dagent/data/opencode` mounted at `/root/.local/share/opencode`. Workspace storage at `/workspace` is separate and must not be used as a substitute for this provider data contract. Never inspect, print, or copy provider auth files into the repository.

Implemented opencode endpoints:

- `GET /global/health` returns `{ healthy, version }` for Telegram `/health`.
- `GET /provider` lists opencode providers and models for Telegram `/model`.
- `POST /session` creates a session with a title like `Telegram chat <chatId>`.
- `POST /session/:id/message` sends text parts to an existing opencode session.

Configuration comes from environment variables loaded in `services/telegram/src/config.ts`:

- `OPENCODE_SERVER_URL` defaults to `http://127.0.0.1:4096`.
- `OPENCODE_SERVER_HOSTNAME` defaults to `127.0.0.1` for managed server startup.
- `OPENCODE_SERVER_PORT` defaults to `4096` for managed server startup.
- `OPENCODE_SERVER_DIRECTORY` defaults to `/Users/davidsnir/ai-projects/personal-agent` and is the managed server cwd; relative overrides resolve from the selected Personal Agent runtime directory.
- `OPENCODE_SERVER_PRINT_LOGS` defaults to `true` and controls `--print-logs` plus process output forwarding.
- `OPENCODE_SERVER_AUTO_START` defaults to `true`; operators can inspect or persist this setting with `dagent --runtime-directory <live-folder> services status opencode`, `services enable opencode`, and `services disable opencode`.
- `OPENCODE_SERVER_PASSWORD` enables HTTP Basic auth.
- `OPENCODE_SERVER_USERNAME` sets the Basic auth username; without it, password auth uses username `opencode`.
- `OPENCODE_AGENT` is sent as `agent` in message bodies when set.
- `OPENCODE_MODEL` initializes the selected model. Telegram `/model <provider/model>` can change the process-local selected model for later message bodies without editing `.env` or `.settings`.
- `OPENCODE_DIRECTORY` is added to every opencode request as the `directory` query parameter and is included in session titles for visibility. If it is omitted, opencode uses the managed server process current directory, which defaults to `/Users/davidsnir/ai-projects/personal-agent`.
- `OPENCODE_REQUEST_TIMEOUT_MS` defaults to `120000`, must be positive and at most `600000`, and bounds Telegram-facing opencode HTTP calls. The generic `OpencodeClient` uses the same `120000` default when no explicit value is passed.

Model listing and selection are implemented through the generic `AgentService` model methods. The Telegram container path uses `services/telegram/src/telegram/opencodeTelegramAgent.ts`; other app paths may use `services/agent/src/opencode/opencodeClient.ts`. Model listing reads `GET /provider`, uses `response.all` providers, filters to `response.connected` provider IDs when that array is non-empty, and exposes each model as the exact Telegram-settable ID `providerId/modelId`. The model ID prefers `model.id` and falls back to the provider model map key; display names fall back to IDs when omitted by opencode. `setModel()` trims input, rejects empty strings, validates exact IDs against `listModels()`, and updates only the in-memory `selectedModel` field. There is no persistence: process startup initializes `selectedModel` from `OPENCODE_MODEL`, Telegram `/model <provider/model>` changes it for future messages in that process, and restart returns to the configured environment/default behavior.

Message bodies use opencode text parts: `{ parts: [{ type: "text", text }] }`. When a selected model exists, the message body includes `model: "provider/model"`; when `OPENCODE_AGENT` is set, it includes `agent`. Message responses are reduced to text by joining each non-reasoning response part's `text` or `content` field with blank lines. Parts with `type: "reasoning"` (model internal reasoning) are filtered out before joining so they never reach the user. If no text is returned, Telegram receives `opencode returned an empty response.`

## Rules

- Keep the `directory` query parameter behavior when `OPENCODE_DIRECTORY` is set.
- Preserve the default managed server cwd `/Users/davidsnir/ai-projects/personal-agent` unless the user explicitly requests a different target project.
- Do not touch unrelated files in an opencode project or selected live folder while maintaining this repository.
- Do not send opencode auth credentials unless `OPENCODE_SERVER_PASSWORD` is configured.
- Preserve the default local server URL unless a verified runtime change requires another default.
- Keep `OPENCODE_SERVER_URL` as the HTTP client target; derive its default from hostname and port but allow explicit overrides.
- When auto-start is disabled, do not start, stop, or require ownership of an opencode child process.
- Keep the `services` opencode toggle mapped only to `OPENCODE_SERVER_AUTO_START`; disabling it must not change opencode HTTP client configuration or MCP config.
- During managed shutdown, prefer `SIGTERM` and escalate to `SIGKILL` only after the existing timeout behavior.
- Encode session IDs in message paths with `encodeURIComponent`.
- Include `accept: application/json` for all opencode requests and `content-type: application/json` when a body exists.
- Bound opencode HTTP requests with `AbortSignal`, report actionable timeout guidance, and sanitize/truncate non-2xx and transport errors before exposing them.
- Do not invent unsupported opencode API fields without checking the server contract; model listing uses documented `GET /provider`, and model selection keeps using the documented message-body `model` field.
- Keep Telegram model changes process-local unless persistent model storage is intentionally added.
- Keep local opencode config installation scoped to `<runtimeDirectory>/opencode.json` unless an explicit config path is provided for a documented deployment boundary such as standard Compose writing `/agent-runtime/opencode.json`.
- Keep standard Compose `OPENCODE_CONFIG=/runtime/opencode.json` and ensure control-api's writable path refers to the same host root file.
- Keep OpenCode provider data persisted at `/root/.local/share/opencode`; do not move it into workspace or broad runtime mounts.
- Preserve unrelated fields in `opencode.json` when installing or updating Calendar or WhatsApp MCP entries.
- Preserve `environment.DAGENT_RUNTIME_DIRECTORY` in generated local MCP entries so opencode-launched MCP processes use the selected live folder independent of cwd; remote MCP entries use only their URL and optional headers.
- Keep the WhatsApp MCP entry database-only; opencode MCP calls must not contact WAHA or send immediately.
- Filter `type: "reasoning"` parts out of opencode message responses before joining text; model internal reasoning must never reach the Telegram user. This filtering must happen in every Telegram-facing opencode adapter, including `OpencodeTelegramAgent.sendMessage()`.

## Verification

Run static checks after integration changes:

```sh
npm run typecheck
npm run build
```

Manual verification requires `opencode serve` running at `OPENCODE_SERVER_URL`. `dagent --runtime-directory <live-folder> start` is the normal CLI path because it selects the live folder and then starts all enabled services; by default that includes managed opencode and Telegram but not Calendar or WhatsApp. Use Telegram `/health` to confirm `GET /global/health`, `/model` to confirm `GET /provider` and inline keyboard rendering, `/model 1` or tap the first button to confirm model selection updates the message, send ordinary chat text to confirm selected-model `POST /session/:id/message`, and `/new` to confirm `POST /session`. Avoid startup commands in automated checks when opencode, Telegram, Calendar, or WhatsApp side effects would be unsafe.

For lifecycle-only changes that affect managed shutdown, `npm run typecheck && npm run build` is the safe automated verification. Startup commands are not required unless the user approves local `opencode serve` and Telegram side effects.

For native runtime config changes, build and run `node dist/cli/src/cli.js --runtime-directory <temporary-live-folder> services init`, then inspect local entries and their `environment.DAGENT_RUNTIME_DIRECTORY`. For Compose config changes, use `services init compose` and verify the two exact remote entries plus preservation of unrelated fields. Restart opencode to load changed config.

The CLI services reorganization updated generated MCP commands to lowercase `dagent services mcp calendar|whatsapp` and was reported verified through safe non-startup CLI checks.

The 2026-07-22 canonical remediation verified provider auth survived agent recreation through `data/opencode`, root config contained both remote MCPs, the loopback agent was healthy, and a minimal isolated model response completed successfully.

## Child Instructions

| Instruction File | Description |
| --- | --- |
| instruction/runtime-directory.md | MCP cwd-independent local path resolution rules. |
| instruction/google-calendar.md | Calendar MCP launched through opencode local config. |
| instruction/whatsapp.md | WhatsApp MCP launched through opencode local config. |
