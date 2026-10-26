# Bootstrap Instructions

## Scope

This file covers first-run initialization and later rehydration when a project still contains template placeholder context.

## Context

This repository is intended to be copied as a template. The reusable machinery is the opencode configuration, agent prompts, and recursive documentation process. The generated project's identity must live in `AGENTS.md`, `instruction/project.md`, and project-specific child instruction files.

Use this file when:

- The user asks to initialize a project from the template.
- `instruction/project.md` still describes template placeholders.
- `AGENTS.md` or instruction files mention irrelevant template examples.
- A no-context agent cannot determine the real project purpose.

## Rules

- Preserve reusable workflow files unless the user asks to change the workflow.
- Replace placeholder project context with the generated project's real context.
- Keep `AGENTS.md` as a concise root router, not a deep architecture document.
- Create project-specific child files under `instruction/` for architecture, runtime, verification, APIs, data model, deployment, or domain rules as needed.
- Add every new child file to the nearest relevant `Child Instructions` table.
- Remove template-only examples and stale routes that do not apply to the generated project.
- Ask one short clarification if the project purpose or runtime cannot be inferred from files.
- Do not invent commands, services, or architecture that are not visible in files or provided by the user.

## Verification

After bootstrap, verify that a no-context agent can answer:

- What is this project?
- Where does implementation start?
- How is the project run and verified?
- What external services or secrets exist?
- Which instruction file should be read next for each major area?
- Which template-only references were removed or intentionally kept?

## Child Instructions

| Instruction File | Description |
| --- | --- |
| instruction/project.md | Current project purpose and layout. |
| instruction/documentation-process.md | Recursive instruction maintenance process. |
