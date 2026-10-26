# Service Isolation Plan

## Scope

This file tracks the plan to make service builds and containers dependency-closed. Use it when changing cross-service imports, service Dockerfiles, independent package dependency ownership, or service entry points.

## Context

Personal Agent is split into independent TypeScript packages under `cli/` and `services/`, with shared helpers under `shared/`. Service containers should copy and compile only the source needed by that service boundary. Cross-service imports make Docker image boundaries wider, can pull unrelated runtime dependencies into builds, and obscure which package owns configuration or lifecycle contracts.

## Goal

Each runtime service should build and run from its own source boundary, plus `shared/`, without importing another service's `src/` tree. The only exception should be an explicit supervisor or control-plane package whose job is to compose multiple services.

## Current Coupling

- Completed: `services/calendar/src/googleCalendarCacheService.ts` imports the `AppService` lifecycle type from `shared/service/appService.ts`.
- Superseded: the native WhatsApp app-service worker was removed by the WAHA migration.
- Completed: `services/agent/src/opencode/opencodeClient.ts` owns a narrow `OpencodeClientConfig` type instead of importing the broad Telegram `Config` type.
- `services/cli-api/src/dagentApiService.ts` imports Calendar implementation modules and Agent opencode runtime config helpers as an intentional control-plane composition boundary. It imports the lifecycle contract from `shared/service/appService.ts`.
- `services/telegram/src/app.ts` composes native opencode, Calendar, Telegram, and API services; it no longer starts WhatsApp.
- Calendar, WhatsApp MCP, and Telegram images are source-closed. Control-api intentionally copies Calendar, Agent, and WhatsApp repository/config source as a control-plane composition boundary.

## Rules

- Keep Calendar and WhatsApp MCP images source-closed to their service plus `shared/`.
- Put cross-service contracts in `shared/` when multiple services need only a type or utility.
- Do not import another service's broad config type when a narrow local config shape is sufficient.
- Treat `cli-api` cross-service imports as deliberate control-plane coupling, not as a pattern for worker services.
- Do not add package dependencies merely to hide source-level coupling; fix the boundary or document an intentional control-plane exception.
- Preserve existing operator behavior for `npm start`, `dagent start`, and compose services unless the user approves a runtime boundary change.

## Target Boundaries

- `services/calendar` may import only `services/calendar/**`, `shared/**`, and npm packages declared by `@personal-agent/calendar`.
- `services/whatsapp` may import only `services/whatsapp/**`, `shared/**`, and npm packages declared by `@personal-agent/whatsapp`.
- `services/agent` should not import Telegram implementation or Telegram config types.
- `services/telegram` should own Telegram polling/chat behavior and its local opencode HTTP adapter; do not import or copy `services/agent` unless the boundary is explicitly redesigned.
- `services/cli-api` is an intentional control-plane service and owns WAHA integration while reusing WhatsApp repository/config source.
- A future `services/supervisor` package may import multiple services to preserve all-in-one local startup behavior.

## Migration Phases

### Phase 1: Shared Lifecycle Contract

Status: completed.

- Move the service lifecycle contract from `services/telegram/src/telegram/appService.ts` to `shared/service/appService.ts`.
- Update all `AppService` imports to use `shared/service/appService.js`.
- Keep the type shape unchanged:

```ts
export type AppService = {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
};
```

- After this phase, Calendar and WhatsApp should no longer need Telegram source only for the lifecycle type.

### Phase 2: Agent Config Boundary

Status: completed.

- Replace the Telegram `Config` import in `services/agent/src/opencode/opencodeClient.ts` with a narrow opencode client config type.
- The narrow type should include only fields used by `OpencodeClient`:
  - `opencodeServerUrl`
  - `opencodeServerUsername`
  - `opencodeServerPassword`
  - `opencodeAgent`
  - `opencodeModel`
  - `opencodeDirectory`
  - `opencodeRequestTimeoutMs`
- Define the type near the client unless another service needs to import it independently.

### Phase 3: Source-Closed Worker Images

Status: completed for Calendar, WhatsApp MCP, and Telegram images; control-api is an explicit composition exception.

- Update `services/calendar/Dockerfile` so the source copy closure is only:

```Dockerfile
COPY services/calendar ./services/calendar
COPY shared ./shared
```

- Update `services/whatsapp/Dockerfile` so the source copy closure is only:

```Dockerfile
COPY services/whatsapp ./services/whatsapp
COPY shared ./shared
```

- Keep independent package manifest copies, BuildKit npm cache mounts, `npm ci --prefix`, package builds, and package prunes unless verified otherwise.
- Keep `services/telegram/Dockerfile` source copies limited to:

```Dockerfile
COPY services/telegram ./services/telegram
COPY shared ./shared
```

- Keep `services/telegram/Dockerfile.dockerignore` as an allowlist so the Telegram Docker build context contains only root `tsconfig.json`, `shared/**`, and `services/telegram/**` before Dockerfile-level copies run.

### Phase 4: Supervisor Decision

- Decide whether to create `services/supervisor` for all-in-one local startup.
- If created, move `runApp()` and the all-service composition currently in `services/telegram/src/app.ts` into `services/supervisor`.
- Preserve existing operator behavior for `npm start` and `dagent start` unless the user explicitly approves a runtime behavior change.
- Keep `services/telegram/src/telegramIndex.ts` and `services/telegram/src/telegramService.ts` as Telegram-only container entry points.

### Phase 5: CLI API Boundary

- Short-term acceptable state: classify `cli-api` as an intentional control-plane package and document its cross-service imports.
- Long-term cleaner state: move Calendar auth/control behavior behind Calendar-owned endpoints and move opencode MCP install helpers into shared opencode utilities, so CLI API talks to services over HTTP instead of importing their implementation.

### Phase 6: Independent Package Manifest Cleanup

Status: completed.

- Service Dockerfiles no longer copy unrelated package manifests before dependency install.
- Each TypeScript service Dockerfile copies root `tsconfig.json` plus only the owning package's `package.json`, `package-lock.json`, and `tsconfig.json` before `npm ci --prefix services/<name>`.
- Calendar and WhatsApp Dockerfiles are package-manifest-closed to their owning package before install.
- Runtime stages copy only the pruned owning package `node_modules`, not root or sibling package dependencies.

## Dependency Ownership Rules

- Runtime dependencies belong to the narrowest independent package that imports or executes them.
- Root runtime dependencies should stay empty unless a deliberate root-runtime package boundary is added and documented.
- Cross-service TypeScript imports are source-level coupling, not npm package dependencies.
- Do not add package dependencies to paper over unwanted service coupling.
- Keep all service images free of WhatsApp Web, Puppeteer, and Chromium; QR belongs only to control-api.

## Verification

Use safe checks after each phase:

```sh
npm run typecheck
npm run build:calendar
npm run build:whatsapp
npm run build:telegram
npm run build:cli-api
docker compose config
```

For Docker boundary changes, also run the affected builds:

```sh
docker compose build calendar-worker
docker compose build calendar-mcp
docker compose build whatsapp-mcp
docker compose build telegram
docker compose build control-api
```

Do not run live startup commands unless the user explicitly approves side effects:

```sh
docker compose up
npm start
dagent start
node dist/services/telegram/src/index.js
```

The WAHA boundary update was reported verified with typecheck, 66 tests, full/scoped builds, Compose rendering, control-api and WhatsApp MCP Docker builds, and `git diff --check`.

## Child Instructions

| Instruction File | Description |
| --- | --- |
