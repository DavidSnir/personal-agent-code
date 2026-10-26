# Service Architecture Instructions

## Scope

This file covers Personal Agent's implemented service-oriented architecture, lifecycle contracts, service boundaries, and safe extension rules for future services.

## Context

Personal Agent evolved from a single Telegram-to-opencode bot into a small multi-service Node.js app without adding a framework. The native supervisor owns opencode, Calendar, Telegram, and optional API lifecycles; Compose control-api separately owns WhatsApp WAHA lifecycle.

- `services/telegram/src/app.ts` is the app runner. It loads config, wires dependencies, starts app services, waits for `SIGINT`, `SIGTERM`, or fatal service errors, and stops started services in reverse order.
- `shared/service/appService.ts` defines the app lifecycle contract: each long-running service has `name`, `start()`, and `stop()`.
- `services/telegram/src/telegram/opencodeServerService.ts` is the managed server service for the local `opencode serve` process.
- `services/calendar/src/googleCalendarCacheService.ts` is an optional background cache service added only when `GOOGLE_CALENDAR_ENABLED=true`.
- `services/agent/src/agents/agentService.ts` defines the generic app-facing agent contract for health checks, sessions, and text messages.
- `services/agent/src/agents/opencodeAgent.ts` is the current concrete agent implementation and delegates HTTP work to `services/agent/src/opencode/opencodeClient.ts`.
- `services/telegram/src/telegram/telegramConnectionService.ts` is the current connection service and owns Telegram Bot API long polling, authorization, command handling, replies, fatal polling supervision, and graceful polling shutdown.
- `services/telegram/src/telegram/credentials.ts` is the Telegram connection gateway credential store used before the Telegram service is constructed.
- `shared/utils/serviceSettings.ts` defines native toggles for opencode, Telegram, Calendar, and the DAgent API.
- `services/cli-api/src/whatsapp/whatsappControlService.ts` owns Compose WAHA lifecycle, durable processing, and scheduled sends outside `runApp()`.

The app runner creates services in this shape:

```text
services/telegram/src/index.ts
  -> runApp() in services/telegram/src/app.ts
       -> loadConfig({ runtimeDirectory? })
          -> load Telegram env overrides or persisted credentials only when TELEGRAM_ENABLED=true
       -> create fatal handler promise
       -> optional OpencodeServerService(config, fatal) when OPENCODE_SERVER_AUTO_START=true
        -> optional GoogleCalendarCacheService when GOOGLE_CALENDAR_ENABLED=true
        -> optional OpencodeAgent(OpencodeClient) when TELEGRAM_ENABLED=true
        -> optional TelegramConnectionService({ token, allowedUserId, agent, onFatal: fatal })
         -> optional DagentApiService when DAGENT_API_ENABLED=true
       -> start enabled services in dependency order
       -> wait for shutdown signal or fatal service error
       -> stop started services in reverse order
```

Fatal native failures include unexpected managed `opencode serve` exit and unrecoverable Telegram polling errors. `runApp()` stops started native services in reverse order. WAHA failures are handled by Compose/control-api startup and are not routed through the Telegram supervisor.

Startup failures use the dependency-order model: `runApp()` records only successful starts and stops them in reverse order before rethrowing.

Do not add WhatsApp back to this native service model. Its only live runtime is the Compose `waha` plus `control-api` boundary; local WhatsApp MCP remains database-only.

## Rules

- Keep `AppService` small: `name`, `start()`, and `stop()` are enough until a verified need appears.
- Start dependencies before dependents; the opencode server must be ready before Telegram forwards messages to the opencode-backed agent.
- Stop only services that were successfully started, and stop them in reverse start order.
- Service `stop()` methods must await their own in-flight background work before closing shared resources such as SQLite databases.
- Preserve `SIGINT` and `SIGTERM` handling in the app runner; do not leave managed child processes behind.
- Route fatal background failures through the app runner so shutdown cleanup still runs.
- Supervise background promises that can end unexpectedly; do not rely on unhandled rejections or process exit to clean up services.
- Keep optional native services disabled by default when they need external credentials, OAuth, or local cache files.
- Keep process management separate from agent HTTP usage: `OpencodeServerService` owns the child process, while `OpencodeAgent` and `OpencodeClient` own opencode API calls.
- Keep agent HTTP calls bounded by the opencode request timeout and sanitize downstream errors before surfacing them.
- Keep `AgentService` generic and avoid naming the app-facing abstraction after opencode.
- Preserve owner-only Telegram authorization by the effective numeric allowed user ID before command or agent work.
- Keep Telegram credential acquisition outside service startup; startup may load env or persisted credentials when Telegram is enabled but must not prompt.
- Keep `TELEGRAM_ENABLED=false` as a true service-disable state: do not load Telegram credentials, construct `OpencodeAgent` only for Telegram, or start long polling.
- Keep WAHA out of native startup and keep QR pairing an explicit remote CLI action.
- Preserve Telegram long polling unless the user explicitly requests webhooks.
- Preserve the default opencode host, port, URL, and server directory unless the user intentionally changes runtime configuration.
- Do not create or edit files under `/Users/davidsnir/ai-projects/personal-agent`; that path is only the default runtime cwd for managed `opencode serve`.
- Do not add a framework unless the current service model cannot stay simple without one.

## Verification

For service architecture changes, run:

```sh
npm run typecheck
npm run build
```

Manual lifecycle verification can include `npm start` with real env or persisted Telegram credentials, then `SIGINT` or `SIGTERM`, and observing that Telegram polling stops and the managed opencode process is cleaned up. Avoid `npm start` during automated verification unless intentionally testing local opencode startup and Telegram side effects.

For fatal lifecycle changes, `npm test && npm run typecheck && npm run build` is safe automated verification. Skip native and Compose startup unless side effects are approved.

## Child Instructions

| Instruction File | Description |
| --- | --- |
| instruction/service-settings.md | Runtime service enablement CLI and env mappings. |
| instruction/google-calendar.md | Optional calendar cache service lifecycle and MCP behavior. |
| instruction/whatsapp.md | WAHA control, SQLite lifecycle, and MCP scheduling service. |
