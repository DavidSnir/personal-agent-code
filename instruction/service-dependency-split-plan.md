# Independent Package Dependency Architecture

## Scope

This file covers the implemented split from npm workspaces into independent private packages and the Docker build pattern that installs only the dependencies each service image needs.

## Context

Personal Agent is a private Node.js and TypeScript repository without npm workspaces. The root `package.json` is an aggregate development package: it owns the `dagent`/`DAgent` bins, root `build`, `typecheck`, `test`, and `start` scripts, service build scripts, Node engine constraint, and whole-repo devDependencies needed for TypeScript builds and tests. The root package must not declare `workspaces`, and it must not have runtime `dependencies`.

`cli/` and `services/{agent,telegram,calendar,cli-api,whatsapp}/` are independent private npm packages. Browser dependencies were removed repository-wide; control-api now intentionally owns QR rendering and WhatsApp SQLite/WAHA orchestration dependencies.

Implemented dependency ownership:

| Package | Runtime dependencies | Reason |
| --- | --- | --- |
| `@personal-agent/cli` | `@modelcontextprotocol/sdk`, `better-sqlite3`, `dotenv`, `googleapis`, `open`, `zod` | Native CLI owns Calendar/local database-only MCP command code. |
| `@personal-agent/agent` | none | The agent package currently owns opencode client/config source without external runtime packages. |
| `@personal-agent/telegram` | `dotenv` | Telegram config loads runtime `.env`; it does not own Calendar, SQLite, MCP, or WhatsApp packages. |
| `@personal-agent/calendar` | `@modelcontextprotocol/sdk`, `better-sqlite3`, `dotenv`, `googleapis`, `open`, `zod` | Calendar worker and MCP code use Google APIs, SQLite, OAuth/browser open, and MCP schemas. |
| `@personal-agent/cli-api` | `better-sqlite3`, `dotenv`, `googleapis`, `open`, `qrcode-terminal` | Control API owns Calendar plus WAHA lifecycle, QR, webhooks, sends, and SQLite. |
| `@personal-agent/whatsapp` | `@modelcontextprotocol/sdk`, `better-sqlite3`, `dotenv`, `zod` | WhatsApp package owns database-only MCP and shared repository/config code. |

Root build scripts now include service-scoped TypeScript builds:

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "build:calendar": "tsc -p services/calendar/tsconfig.json",
    "build:cli-api": "tsc -p services/cli-api/tsconfig.json",
    "build:telegram": "tsc -p services/telegram/tsconfig.json",
    "build:whatsapp": "tsc -p services/whatsapp/tsconfig.json",
    "test": "npm run build && node --test test/*.test.mjs",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

Scoped TypeScript configs extend the root `tsconfig.json` but include only service entrypoints and imported local source closure:

| Config | Included entrypoints | Local source closure copied by Docker |
| --- | --- | --- |
| `services/telegram/tsconfig.json` | `src/telegramIndex.ts` | `services/telegram`, `shared` |
| `services/calendar/tsconfig.json` | `src/workerIndex.ts`, `src/mcp/httpIndex.ts` | `services/calendar`, `shared` |
| `services/cli-api/tsconfig.json` | `src/index.ts`, restart helper, `src/whatsapp/**/*.ts` | Agent, Calendar, CLI API, WhatsApp repository/config, shared |
| `services/whatsapp/tsconfig.json` | `src/mcp/httpIndex.ts`, `src/mcp/whatsappMcpServer.ts` | `services/whatsapp`, `shared` |

The shared app-service lifecycle contract lives in `shared/service/appService.ts`; Calendar, Telegram, and CLI API import it from shared. WhatsApp MCP has no app-service worker.

Every service Dockerfile that builds TypeScript now uses Dockerfile syntax `docker/dockerfile:1.7`, copies root `package.json` and root `tsconfig.json` plus only the owning package's `package.json`, `package-lock.json`, and `tsconfig.json` before source, installs with BuildKit npm cache and retry flags, copies only the local source needed for that service build, runs a service-scoped TypeScript build, prunes dev dependencies, and copies only the pruned owning package `node_modules` plus `dist/` into the runtime stage. Nested-package Docker builds must copy the root manifest beside the root tsconfig so TypeScript `module: NodeNext` sees the repository package scope with `"type": "module"` while compiling `shared` and service source into `dist/**/*.js`. The root manifest is not used for dependency installation in these images; installs remain package-scoped with `--prefix services/<name>`. The Telegram image is the deliberate flattened-layout exception: it copies `services/telegram/package.json` and `package-lock.json` to `/app/`, runs `npm ci` and `npm prune --omit=dev` at `/app`, and does not create a `node_modules` symlink.

The root Docker build context is governed by `.dockerignore`, which must exclude `**/node_modules/`, not only root `node_modules/`. Source-copy steps such as `COPY services/cli-api ./services/cli-api` occur after the image's Linux package-scoped `npm ci`; allowing a host `services/cli-api/node_modules` into that copy can overwrite the installed tree. On macOS this can silently replace Linux native addons such as `better_sqlite3.node` with Mach-O binaries that are then copied into the control-api runtime image.

The default independent package install/prune pattern is:

```Dockerfile
COPY package.json tsconfig.json ./
COPY services/<service>/package.json services/<service>/package-lock.json services/<service>/tsconfig.json ./services/<service>/

RUN --mount=type=cache,target=/root/.npm npm ci --prefix services/<service> \
  --fetch-retries=5 \
  --fetch-retry-mintimeout=20000 \
  --fetch-retry-maxtimeout=120000 \
  --fetch-timeout=300000 \
  --no-audit \
  --fund=false
RUN ln -s services/<service>/node_modules node_modules

RUN npm run build --prefix services/<service>
RUN npm prune --omit=dev --prefix services/<service> \
  --no-audit \
  --fund=false
```

For nested TypeScript service Dockerfiles such as `services/calendar/Dockerfile`, `services/cli-api/Dockerfile`, and `services/whatsapp/Dockerfile`, keep the first copy step as `COPY package.json tsconfig.json ./` rather than `COPY tsconfig.json ./`. Removing the root manifest can make Docker builds emit CommonJS wrappers into `.js` files that the runtime stage then treats as ESM because its copied service `package.json` has `"type": "module"`, causing misleading named-export crashes such as `getDefaultRuntimeDirectory` missing from `dist/shared/utils/runtimeDirectory.js`.

The default runtime stage must copy from the owning package, not from root:

```Dockerfile
COPY --from=build /app/services/<service>/package.json /app/services/<service>/package-lock.json ./
COPY --from=build /app/services/<service>/node_modules ./node_modules
COPY --from=build /app/dist ./dist
```

The WhatsApp Docker image starts `node dist/services/whatsapp/src/mcp/httpIndex.js` and is MCP-only. Control-api starts `services/cli-api/src/index.ts` and directly owns WAHA integration.

The Telegram Dockerfile intentionally uses a flattened package layout instead of the default pattern:

```Dockerfile
COPY services/telegram/package.json services/telegram/package-lock.json ./
COPY tsconfig.json ./
COPY services/telegram/tsconfig.json ./services/telegram/tsconfig.json
RUN --mount=type=cache,target=/root/.npm npm ci ...
COPY services/telegram ./services/telegram
COPY shared ./shared
RUN npx tsc -p services/telegram/tsconfig.json
RUN npm prune --omit=dev ...
```

This keeps a single copy of Telegram package metadata at `/app`, gives Node the package ESM scope for compiled output, and leaves runtime metadata and dependencies at `/app/package.json`, `/app/package-lock.json`, and `/app/node_modules`.

## Rules

- Keep root `package.json` free of `workspaces` and runtime `dependencies` unless a deliberate root-runtime package boundary is added and documented.
- Keep root dev dependencies and whole-repo scripts working for local development, tests, typecheck, and full builds.
- Add new runtime packages to the independent package that imports or executes them, not automatically to the root package.
- If root `tsconfig.json` or tests compile code that imports a package-owned runtime dependency, add that external package to root `devDependencies` as aggregate build tooling, never root `dependencies`.
- Keep the affected package lock in sync by running npm install from that package directory or with `--prefix <package>`. Root dependency changes update only the root `package-lock.json`.
- Keep the root `package-lock.json` free of `cli` or `services/*` package entries; those belong only in their own package locks.
- Preserve service-scoped build scripts and `services/*/tsconfig.json` files when changing Docker builds.
- Keep service-scoped `tsconfig` includes focused on entrypoints and imported local source; do not include unrelated service trees just because they exist.
- When a service build needs another service's source for an intentional composition boundary, copy that source explicitly in the Dockerfile and document why.
- Keep Dockerfile manifest-copy steps before source-copy steps so dependency layers can be cached separately from TypeScript source changes.
- Keep nested TypeScript service Dockerfiles copying root `package.json` with root `tsconfig.json` before dependency install; this preserves NodeNext ESM emit for shared and service sources during Docker builds without installing root dependencies.
- Keep BuildKit npm cache mounts and npm retry flags in service Dockerfiles to reduce transient registry failure impact.
- Keep Docker install, build, and prune commands package-scoped with `--prefix services/<name>` for the default nested package layout; keep Telegram's flattened `/app` install/prune layout unless deliberately redesigning that image.
- Keep `.dockerignore` excluding `**/node_modules/` so nested host dependencies cannot overwrite container-installed Linux dependencies during source copies.
- Keep the build-stage `node_modules` symlink as `ln -s services/<name>/node_modules node_modules` for default nested package images that need it; do not add that symlink to the current Telegram image.
- In runtime stages, copy only the pruned owning package `node_modules` to `/app/node_modules`; do not copy root `node_modules` or unrelated service dependency folders.
- Keep all packages free of `whatsapp-web.js`, Puppeteer, and Chromium dependencies.
- Keep `qrcode-terminal` in control-api only; CLI and WhatsApp MCP do not render WAHA QR payloads.
- Keep control-api's intentional copy/import of WhatsApp repository/config source explicit in its Dockerfile and tsconfig.
- Keep runtime state and secrets out of images; dependency splitting must not copy `.env`, `.settings`, SQLite files, OAuth tokens, Telegram credentials, WhatsApp sessions, or generated runtime data.
- Do not replace service foreground Docker entrypoints with `dagent start` or other startup supervisors as part of dependency changes.

## Follow-up Notes

The native CLI remains intentionally broad because `cli/src/cli.ts` imports Calendar and WhatsApp command flows in-process. If the CLI dependency footprint becomes a problem, split CLI command implementations so heavy Calendar and WhatsApp code is dynamically loaded only for commands that need it, then revisit `@personal-agent/cli` dependencies.

`shared/utils/serviceSettings.ts` imports `dotenv`, but `shared` is not an npm package. Until shared utilities become their own package, each independent package that builds source importing shared dotenv behavior must carry `dotenv` if the compiled service needs it at runtime.

Cross-service TypeScript imports are source-level boundaries, not npm package dependencies. A successful package-scoped `npm ci --prefix ...` is not enough; scoped builds and Docker source-copy closures must also be verified.

## Verification

Safe verification after dependency ownership, scoped TypeScript config, or service Dockerfile changes:

```sh
npm ci
npm run typecheck
npm run build:telegram
npm run build:calendar
npm run build:cli-api
npm run build:whatsapp
npm test
npm run build
docker compose config
docker compose build telegram
docker compose build control-api
docker compose build calendar-worker
docker compose build calendar-mcp
docker compose build whatsapp-mcp
git diff --check
```

After nested TypeScript Dockerfile changes, use no-startup imports of shared helpers and config modules. Do not import active entrypoints such as Calendar `workerIndex.js`, MCP HTTP indexes, or `cli-api/src/index.js`, because they start workers or bind ports.

When manifests change, verify no-workspace invariants and assert locks contain no `whatsapp-web.js`, Puppeteer, or Puppeteer browser packages.

Do not run startup commands without approval. Avoid `docker compose up`, native startup, live OAuth, Telegram polling, WAHA auth, webhooks, and sends.

The independent-package conversion was reported verified with `npm ci`, `npm run typecheck`, all four `build:<service>` scripts, `npm test` with 59 passing tests, `npm run build`, `docker compose config`, no-workspace/lock sanity checks, Docker builds for Calendar, WhatsApp, CLI API, and Telegram services, and `git diff --check`. The initial dependency split was previously reported verified with `npm install`, service builds, tests, Docker config/build checks, and `git diff --check`; stale workspace guidance from that phase no longer applies.

The recursive `node_modules` Docker-context exclusion was verified with `docker compose build control-api`, a one-shot query through the built image's `better-sqlite3` addon returning `1`, `npm run build --prefix services/cli-api`, and `git diff --check`. A later no-cache rebuild reached external `deb.debian.org` DNS/timeouts; treat that as an external network limitation rather than evidence that host native addons re-entered the image.

## Child Instructions

| Instruction File | Description |
| --- | --- |
