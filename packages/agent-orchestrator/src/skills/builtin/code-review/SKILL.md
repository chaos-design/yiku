---
name: code-review
description: Review code changes for defects, regressions, and missing tests. Invoke for pull requests, commits, branches, patches, or uncommitted workspace changes.
version: 1.0.0
agentTypes:
  - code
mcp: []
---

# Code Review

Review the requested change as a defect-finding task.

## Workflow

1. Establish the review scope and read the complete diff plus affected surrounding code.
2. Read repository instructions and tests that define the intended behavior.
3. Trace changed inputs, state transitions, failure paths, cleanup, concurrency, and public contracts.
4. Check whether tests cover the new behavior and credible regressions.
5. Report only actionable findings supported by a concrete trigger and impact.

Prioritize:

- Incorrect behavior and state corruption.
- Security or permission boundary regressions.
- Data loss, race conditions, leaks, and incomplete cleanup.
- Broken compatibility or public contracts.
- Material performance regressions.
- Missing tests for changed behavior.

## Finding Format

For each finding, include:

- Severity: critical, high, medium, or low.
- Confidence: high, medium, or low.
- A precise file and line reference.
- The triggering scenario.
- The user or system impact.
- The smallest credible repair direction.

## Constraints

- Put findings before summaries.
- Do not report style preferences as defects.
- Avoid speculative findings that lack a reachable failure path.
- Do not modify code unless the user explicitly asks for fixes.
- If no findings remain, say so and list untested areas or residual risk.
