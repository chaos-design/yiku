---
name: test-driven-development
description: Implement behavior through a failing test and minimal fix. Invoke for new features, bug fixes, or observable behavior changes that can be tested.
version: 1.0.0
agentTypes:
  - code
mcp: []
---

# Test-Driven Development

Use a red, green, refactor loop at the narrowest observable behavior boundary.

## Workflow

1. Read the relevant implementation, nearby tests, and repository test conventions.
2. Define one observable behavior and choose the smallest test level that proves it.
3. Add or update a test that fails for the intended reason.
4. Run the focused test and inspect the failure. A syntax, fixture, or environment failure is not a valid red state.
5. Implement the smallest coherent production change that satisfies the behavior.
6. Run the focused test to green.
7. Refactor only when it improves the changed code without broadening scope.
8. Run affected regression tests, then the repository-required lint and build checks when appropriate.

## Constraints

- Do not weaken assertions, delete coverage, or change expected behavior merely to make a test pass.
- Prefer public behavior over private implementation details.
- Preserve unrelated user changes.
- Do not add abstractions without demonstrated reuse or complexity reduction.
- If the environment cannot produce a valid red state, stop and report the blocker.
- In a read-only worker, return the proposed test cases and implementation points without claiming edits or command execution.

## Output

Report:

- Behavior under test.
- Red-state evidence.
- Minimal implementation made or proposed.
- Focused and regression verification.
- Remaining gaps or blockers.
