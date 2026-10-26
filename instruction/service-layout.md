# Service Layout Instructions

## Scope

This file covers the repository file layout for Personal Agent services, shared directories, TypeScript source placement, independent package manifests, and build-path invariants after the service-layout refactor.

## Context

The project root contains service directories instead of a top-level application `src/` tree. The durable layout is:

```text
services/
  agent/
    src/
    Dockerfile
    package.json
  cli-api/
    src/
    Dockerfile
    package.json
  telegram/
    src/
    Dockerfile
    package.json
  calendar/
    src/
    Dockerfile
    package.json
  whatsapp/
    src/
    Dockerfile
    package.json
shared/
  utils/
  types/
docker-compose.yml
README.md
```

The implemented Node.js/TypeScript source is split across the top-level native CLI folder, service-scoped folders, and shared utilities. `tsconfig.json` uses `rootDir: "."` and includes `cli/src/**/*.ts`, `services/*/src/**/*.ts`, and `shared/**/*.ts`, so `npm run build` emits nested output paths such as `dist/cli/src/cli.js`, `dist/services/telegram/src/index.js`, `dist/services/cli-api/src/index.js`, and `dist/shared/utils/runtimeDirectory.js`. Runtime state belongs under a selected live directory, not this source tree. Do not recreate a top-level `src/` tree for application code unless the project layout is intentionally changed again.

The root `package.json` does not declare npm workspaces. It points both `dagent` and `DAgent` bins to `dist/cli/src/cli.js`, runs `npm start` through `dist/services/telegram/src/index.js`, owns aggregate build/test/typecheck scripts, and records `serviceLayout` source roots for `cli`, `cli-api`, `telegram`, `agent`, `calendar`, `whatsapp`, and `shared`. The CLI and service package manifests are independent private package manifests with their own package locks and dependency ownership.

Current placement is ownership-oriented: `cli/src` owns the native CLI; `services/cli-api/src` owns HTTP control plus WAHA lifecycle/webhooks/sends; `services/telegram/src` owns native app composition and Telegram; `services/agent/src` owns opencode integration; `services/calendar/src` owns Calendar; `services/whatsapp/src` owns shared WhatsApp config/repository and database-only MCP. Keep new WAHA control code in CLI API and MCP/storage code in WhatsApp.

`shared/utils/` and `shared/types/` are for cross-service code and types. They should stay free of secrets and runtime state. Active shared utility code must remain included by `tsconfig.json`, copied by Dockerfiles, and imported with correct relative paths from service source files.

## Rules

- Put native CLI TypeScript under `cli/src`, service TypeScript under the owning `services/<name>/src` folder, and cross-service utilities under `shared/`, not top-level `src/`.
- Preserve `dist/services/telegram/src/index.js` and `dist/cli/src/cli.js` output paths unless every caller is updated.
- Keep root scripts (`build`, `typecheck`, `test`, `start`, `cli`) working from the repository root.
- Keep service package manifests private unless publishing is explicitly requested.
- Keep runtime state, generated output, secrets, and operator `.env` files out of `services/` and `shared/`.
- When moving code between services or into `shared/`, update imports, TypeScript include/path settings, Dockerfile copy inputs, package scripts/bin paths, tests, and instructions in the same change.
- When adding a new service directory, add its package marker, Dockerfile or documented reason for absence, and route instructions through the nearest parent instruction file.
- Preserve Docker compose build paths pointing at `services/*/Dockerfile` unless container layout is intentionally changed.

## Verification

Run these checks after source-layout or build-path changes:

```sh
npm run typecheck
npm run build
npm test
```

For Dockerfile or compose path changes, also run a targeted Docker build or config check when Docker is available, for example:

```sh
docker compose config
docker compose build telegram
```

The service-layout refactor was reported verified with `npm run typecheck`, `npm run build`, and `npm test`. Docker builds were not reported as part of that verification.

## Child Instructions

| Instruction File | Description |
| --- | --- |
