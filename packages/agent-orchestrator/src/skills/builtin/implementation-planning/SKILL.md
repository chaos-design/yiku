---
name: implementation-planning
description: Build an evidence-based implementation plan. Invoke for cross-file changes, public API work, migrations, or when the user requests a plan before coding.
version: 1.0.0
agentTypes:
  - code
mcp: []
---

# Implementation Planning

Create an implementation-ready plan from repository evidence.

## Workflow

1. Read the workspace instructions, relevant implementation, tests, configuration, and current changes.
2. State the requested outcome and observable completion criteria.
3. Separate confirmed facts from assumptions. Resolve assumptions from the repository where possible.
4. Identify affected ownership boundaries, public contracts, migrations, compatibility risks, and validation commands.
5. Break the work into dependency-ordered steps. Name the files or modules each step is expected to touch.
6. Include focused tests with the step that introduces the behavior, not as a detached final task.
7. Ask the user only about decisions that materially block a coherent plan.

## Constraints

- Do not invent APIs, files, commands, or repository conventions.
- Do not include unrelated refactors.
- Do not use placeholders such as TBD or TODO.
- In a read-only worker, do not modify files.
- When activated in a writable parent turn, remain in planning scope unless the user also asks for implementation.

## Output

Return:

1. Goal and completion criteria.
2. Relevant current behavior.
3. Dependency-ordered implementation steps.
4. Risks and compatibility notes.
5. Validation commands and expected evidence.

Stop when another engineer can execute the plan without rediscovering its key decisions.
