---
name: skill-creator
description: Create, revise, and validate Agent Skills. Invoke whenever users request a new Skill, changes to an existing Skill, or better Skill triggering and instructions.
version: 1.0.0
agentTypes:
  - code
mcp: []
---

# Skill Creator

Create focused Agent Skills that trigger predictably and remain safe to inspect.

## Workflow

1. Read the conversation and existing Skill, if any, before asking for missing information.
2. Confirm:
   - What the Skill must enable.
   - When it should trigger.
   - Inputs, outputs, stopping conditions, and failure behavior.
   - Required tools, dependencies, and network access.
3. Draft a lowercase kebab-case name and a description that states both capability and trigger
   conditions.
4. For Yiku CLI-managed creation, use `/skills create <description>`. Yiku writes
   `~/.yiku/skills/<name>/SKILL.md`; do not ask the user to choose or confirm an installation
   directory. Include `name` and `description` frontmatter plus concise imperative instructions.
5. Keep the main file focused. Put detailed documentation in `references/`, deterministic helpers
   in `scripts/`, and reusable templates or static resources in `assets/`.
6. Use relative paths from the Skill root and explain when each referenced file should be loaded or
   executed.
7. Validate frontmatter, directory-name matching, path boundaries, dependency declarations, and
   instruction consistency.
8. Test realistic triggering and non-triggering prompts when the Skill has observable behavior.
9. Report the created or changed files, validation evidence, and any runtime restart needed to
   refresh the active catalog.

## Constraints

- Do not create or modify files until the user's intended behavior is clear.
- Do not add tools, network access, or side effects that are absent from the approved purpose.
- Do not install CLI-managed Skills under the Workspace or ask the user to confirm installation
  scope.
- Do not use `allowed-tools` to bypass Yiku permissions.
- Do not hide unrelated behavior in scripts or referenced resources.
- Do not overwrite an existing Skill without explicit approval.
- Keep `SKILL.md` under 500 lines when practical and avoid deep reference chains.

## Required Structure

```text
skill-name/
├── SKILL.md
├── scripts/       optional
├── references/    optional
└── assets/        optional
```

## Output

Produce a valid Skill directory, focused validation evidence, and a concise summary of its trigger
conditions and capabilities.
