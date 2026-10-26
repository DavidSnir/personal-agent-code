# Personal Agent Instructions

## Scope

This is the root instruction router for the Personal Agent project. Keep this file concise and route durable project knowledge into child instruction files under `instruction/`.

## Project Context

Personal Agent is a Node.js and TypeScript Telegram bot that connects chats to a local `opencode serve` HTTP instance on this computer.

If `instruction/project.md` is missing or does not describe this project, read `instruction/bootstrap.md` before implementation and bootstrap the project-specific instruction tree.

## Rules

- Start implementation context from `instruction/project.md` when it exists.
- Use `instruction/bootstrap.md` only for first-run initialization or stale template cleanup.
- Preserve reusable opencode workflow files unless the user explicitly asks to change them.
- Store durable project memory in `instruction/` child files, not only in chat, commits, or README prose.
- Add every new instruction file to the nearest relevant `Child Instructions` table.
- Prefer the most specific child instruction file when instructions conflict.

## Child Instructions

| Instruction File | Description |
| --- | --- |
| instruction/bootstrap.md | First-run initialization and stale template cleanup. |
| instruction/project.md | Current project purpose, layout, runtime, and verification. |
| instruction/documentation-process.md | Recursive instruction maintenance process. |
