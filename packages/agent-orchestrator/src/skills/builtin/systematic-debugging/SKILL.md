---
name: systematic-debugging
description: Diagnose failures with reproducible evidence and falsifiable hypotheses. Invoke when root cause is unclear, reproduction is unstable, or prior fixes failed.
version: 1.0.0
agentTypes:
  - code
mcp: []
---

# Systematic Debugging

Find and fix the root cause through evidence, not guesswork.

## Workflow

1. Capture the actual behavior, expected behavior, environment, and smallest known reproduction.
2. Reproduce the failure before changing production code.
3. Trace the failing path through inputs, state transitions, boundaries, and outputs.
4. Form a small set of falsifiable hypotheses ranked by current evidence.
5. Test one hypothesis at a time with focused tests, logs, or minimal temporary instrumentation.
6. Record what each observation proves and eliminate contradicted hypotheses.
7. Implement the narrowest root-cause fix.
8. Add a regression test that fails without the fix and passes with it.
9. Remove temporary instrumentation and run affected verification.

## Constraints

- Do not stack speculative fixes.
- Do not treat correlation as a confirmed cause.
- Do not broaden timeouts, retries, or catches unless evidence shows that policy is the defect.
- Preserve unrelated user changes and existing diagnostics.
- After repeated reproduction failure, stop and report verified facts plus the exact missing evidence.
- In a read-only worker, provide diagnosis and next evidence-gathering steps without claiming edits or command execution.

## Output

Return:

1. Reproduction and evidence.
2. Hypotheses tested and ruled out.
3. Confirmed root cause or current confidence.
4. Fix and regression coverage, if writable.
5. Verification results and residual risk.
