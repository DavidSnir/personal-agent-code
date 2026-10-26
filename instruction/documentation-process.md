# Documentation Process Instructions

## Scope

This file defines how future agents maintain recursive instruction documentation.

## Context

The instruction tree is the durable memory system. A future agent should be able to start at `AGENTS.md`, follow `Child Instructions` tables, and understand a project area without relying on previous chat context.

Instruction files live under `instruction/` at the relevant project root. Template copies should replace placeholder instruction content with the generated project's real context.

## Rules

- Verify actual changes with `git status --short`, `git diff --stat`, and `git diff` before editing instructions.
- Read changed source, config, test, and documentation files needed to understand durable behavior.
- Create or update instruction files under `instruction/` for durable agent-facing memory.
- Add new instruction files to the nearest relevant parent `Child Instructions` table.
- Include a `Child Instructions` table in every instruction file, even when it is empty.
- Keep instruction files self-readable with local scope, context, rules, and verification notes.
- Use child instruction files for deeper detail instead of creating one overloaded document.
- Keep reusable template workflow separate from project-specific memory.
- Remove or rewrite template placeholder context when real project facts are known.
- Update README only for human-facing setup, usage, or operational notes.
- Do not document unrelated work found in the git diff.

## Verification

After documentation edits, read the affected instruction path as a no-context agent and check whether it answers:

- What area does this cover?
- Which files and entry points matter?
- What rules must be preserved?
- What commands or checks verify this area?
- Where should the agent read next?

## Child Instructions

| Instruction File | Description |
| --- | --- |
| instruction/bootstrap.md | Project initialization and rehydration process. |
