# Template Usage

This repository provides reusable opencode workflow agents and a recursive instruction-memory structure for new projects.

## First Run

After copying the template into a new project, initialize project memory before substantial implementation:

1. Start at `AGENTS.md`.
2. Read `instruction/bootstrap.md`.
3. Replace placeholder context in `instruction/project.md` with real project facts.
4. Add project-specific child instruction files under `instruction/`.
5. Add each child file to the nearest relevant `Child Instructions` table.
6. Remove template-only examples and stale routes.

## Reusable Pieces

- `.opencode/agents/orchestrator.md`
- `.opencode/agents/instruction-reader.md`
- `.opencode/agents/documentation-maintainer.md`
- `instruction/documentation-process.md`
- `instruction/bootstrap.md`

## Project-Specific Pieces

- `AGENTS.md` project context bullets may be adjusted during bootstrap.
- `instruction/project.md` must describe the generated project.
- Additional `instruction/` files should reflect the generated project's architecture, runtime, verification, APIs, deployment, and domain rules.

Restart opencode after changing `opencode.json`, `.opencode/agents/`, skills, plugins, or permission rules.
