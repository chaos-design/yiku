---
name: verification-before-completion
description: Verify current workspace evidence before declaring work complete. Invoke after implementation, bug fixes, refactors, or when the user requests final acceptance.
version: 1.0.0
agentTypes:
  - code
mcp: []
---

# Verification Before Completion

Use current evidence to decide whether the requested work is complete.

## Workflow

1. Re-read the request and repository completion requirements.
2. Inspect the final diff and map each requested behavior to implementation and tests.
3. Run the narrowest relevant test first.
4. Run affected unit and integration tests.
5. Run the repository-required linter, type check, and build.
6. Perform a functional check when behavior crosses module or user-facing boundaries.
7. Inspect every failure. Fix regressions within scope and rerun the failed verification.
8. Distinguish passed, failed, not run, and externally blocked checks.

## Constraints

- Do not use historical results as evidence for the current workspace.
- Do not claim success from command exit alone when output reports skipped or failed checks.
- Do not hide unrelated pre-existing failures; identify them separately with evidence.
- Do not mark the task complete while a required check fails.
- In a read-only worker without command execution, mark checks as not run and explain the limitation.

## Output

Use exactly these top-level fields:

```text
code:
linter_result:
unit_test_result:
func_test_result:
status:
```

Set `status` to `complete`, `incomplete`, or `blocked`, and support it with concise current evidence.
