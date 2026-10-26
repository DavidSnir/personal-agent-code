# Canonical Compose Runtime Instructions

## Scope

This file covers the canonical Compose host runtime, narrow bind mounts, initialization, OpenCode configuration and provider persistence, and the completed July 2026 runtime remediation.

## Context

Standard Compose requires a non-empty `HOME` and fixes its host root at `${HOME}/.local/share/dagent`. Native CLI runtime selection remains configurable; pass `--runtime-directory "${HOME}/.local/share/dagent"` or persist that absolute default when a host command must operate on Compose state.

The canonical host layout is:

```text
${HOME}/.local/share/dagent/
  .settings
  opencode.json
  agent/
    .env
    workspace/
  data/
    google-calendar/
      .env
      google-calendar.sqlite
    opencode/
    telegram/
      .env
      credentials.json
    whatsapp/
      .env
      whatsapp.sqlite
      waha-sessions/
```

Run this local command before the first Compose creation:

```sh
dagent --runtime-directory "${HOME}/.local/share/dagent" services init compose
```

`services init compose` creates the bind-source directories with mode `0700`, creates `.settings` and generated `opencode.json` with mode `0600`, initializes the canonical Calendar and WhatsApp SQLite databases, and installs both exact remote MCP entries. For this target, DB initialization deliberately uses `data/google-calendar/google-calendar.sqlite` and `data/whatsapp/whatsapp.sqlite` even if unrelated DB-path environment overrides are present. Existing unrelated valid `opencode.json` fields and MCP entries are preserved; an existing non-object `mcp` field is rejected without replacement.

Compose uses long bind syntax with `create_host_path: false`; missing sources fail instead of Docker silently creating root-owned directories. No service mounts the whole runtime root. Important mappings are:

| Host source | Container target | Consumer |
| --- | --- | --- |
| `agent/workspace` | `/workspace` | `agent` working directory |
| `opencode.json` | `/runtime/opencode.json` read-only | `agent` exact OpenCode config |
| `opencode.json` | `/agent-runtime/opencode.json` writable | `control-api` MCP updates |
| `data/opencode` | `/root/.local/share/opencode` | OpenCode provider data/auth |
| `data/telegram` | `/runtime/data/telegram` | `telegram` |
| `data/telegram` | `/telegram-runtime/data/telegram` | `control-api` |
| `data/google-calendar` | `/runtime/data/google-calendar` | Calendar services/control API |
| `data/whatsapp` | `/whatsapp-runtime/data/whatsapp` | `control-api` |
| `data/whatsapp` | `/runtime/data/whatsapp` | `whatsapp-mcp` |
| `data/whatsapp/waha-sessions` | `/app/.sessions` | `waha` |

The root host `opencode.json` is the one OpenCode reads because Compose sets `OPENCODE_CONFIG=/runtime/opencode.json`. It is also the exact file control-api updates through `/agent-runtime/opencode.json`. Its standard remote entries are `calendar -> http://calendar-mcp:7332/mcp` and `whatsapp -> http://whatsapp-mcp:7333/mcp`.

The agent image runs OpenCode as root. OpenCode provider registry/auth data follows OpenCode's actual data contract at `/root/.local/share/opencode`, persisted to host `data/opencode`. Container recreation must retain this mount. Treat it as secret runtime data: do not inspect, print, copy into the repository, or broaden its exposure.

Host ports `4096` and `8000` are loopback-only. WAHA port `3000` and both MCP ports remain internal to the Compose network.

## Migration Status

Checkpoint `7aaccdd` (`feat(runtime): persist defaults and fix Compose paths`) precedes the full canonical-runtime remediation. The approved migration created backup `~/.local/share/dagent-backups/20260722T173730Z-canonical-runtime-remediation/`; old sources were retained and must not be deleted without a separate verified cleanup request.

As verified on 2026-07-22, Calendar and WhatsApp SQLite state were reconciled into the canonical paths with integrity checks passing; Calendar credentials were preserved without exposure and cache state restored; WhatsApp had no due or `sending` rows. Root `opencode.json` had both remote MCPs, OpenCode provider auth persisted through `data/opencode`, all seven services were rebuilt/recreated, the agent and control API were healthy on loopback, and no duplicate native services were active. A minimal isolated model request completed successfully.

WAHA itself was healthy, internal-only, and GOWS-based, but the persisted `default` pairing transitioned to `FAILED`. WhatsApp authentication is **not** fixed: the operator must run the approved QR re-pair flow before claiming `WORKING`, contact sync, or sends are restored.

## Rules

- Require non-empty `HOME` for standard Compose; do not restore permissive `${HOME}` interpolation.
- Run `services init compose` before creating containers on a fresh canonical root.
- Preserve narrow binds and `create_host_path: false`; never mount the whole runtime root.
- Keep root `opencode.json` as the shared exact config path for agent reads and control-api writes.
- Keep provider auth only under `data/opencode` and never expose its contents.
- Keep agent port `4096` and control API port `8000` loopback-only.
- Preserve old migration sources and backup until an explicit cleanup is approved.
- Do not claim WhatsApp auth or restart restoration works until QR re-pairing reaches `WORKING` and a later restart is verified.

## Verification

```sh
npm test
npm run typecheck
npm run build
docker compose config
HOME= docker compose config   # must fail with the HOME requirement
node --test test/cliCommands.test.mjs test/opencodeRuntimeConfig.test.mjs test/dagentApiRouting.test.mjs
git diff --check
```

Use temporary runtime roots for initialization tests. Live migration, container recreation, OAuth, provider login, Telegram polling, QR pairing, and sends require explicit side-effect approval.

## Child Instructions

| Instruction File | Description |
| --- | --- |
