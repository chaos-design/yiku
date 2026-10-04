import { describe, expect, it } from "vitest";
import {
  createCompletionDecision,
  createEvalAttemptRecord,
  createEvalEvidenceIndex,
  sha256Digest,
  validateCompletionDecision,
  validateEvalAttemptRecord,
  validateEvalEvidenceIndex,
} from "../src/index.js";

describe("evaluation records", () => {
  it("creates and validates immutable attempt records", () => {
    const record = createEvalAttemptRecord({
      attemptId: "attempt",
      contextDigest: sha256Digest({ context: 1 }),
      finishedAt: "2026-08-13T00:00:01.000Z",
      planDigest: sha256Digest({ plan: 1 }),
      scorecardDigest: sha256Digest({ scorecard: 1 }),
      startedAt: "2026-08-13T00:00:00.000Z",
    });

    expect(() => validateEvalAttemptRecord(record)).not.toThrow();
    expect(() =>
      validateEvalAttemptRecord({
        ...record,
        contextDigest: sha256Digest({ context: 2 }),
      }),
    ).toThrow("digest");
    expect(() =>
      createEvalAttemptRecord({
        ...record,
        finishedAt: "2026-08-12T00:00:00.000Z",
      }),
    ).toThrow("must not precede");
  });

  it("creates evidence indexes and rejects duplicates or tampering", () => {
    const evidence = {
      digest: sha256Digest({ evidence: 1 }),
      id: "evidence",
      metadata: { count: 1 },
      ref: "output:sha256:value",
      summary: "Output evidence.",
      type: "output" as const,
      version: 1 as const,
    };
    const index = createEvalEvidenceIndex("attempt", [evidence]);

    expect(() => validateEvalEvidenceIndex(index)).not.toThrow();
    expect(() => createEvalEvidenceIndex("attempt", [evidence, evidence])).toThrow("Duplicate");
    expect(() =>
      validateEvalEvidenceIndex({
        ...index,
        evidence: [
          {
            ...evidence,
            summary: "Changed.",
          },
        ],
      }),
    ).toThrow("digest");
  });

  it("enforces decision and repair invariants", () => {
    const accepted = createCompletionDecision({
      action: "accepted",
      attemptId: "attempt",
      reasons: ["Checks passed."],
      runId: "run",
      taskId: "task",
    });
    const retry = createCompletionDecision({
      action: "retry",
      attemptId: "attempt",
      reasons: ["A retryable check failed."],
      repairInstruction: {
        failedCheckIds: ["check"],
        feedback: "Fix the failed check.",
      },
      runId: "run",
      taskId: "task",
    });

    expect(() => validateCompletionDecision(accepted)).not.toThrow();
    expect(() => validateCompletionDecision(retry)).not.toThrow();
    expect(() =>
      createCompletionDecision({
        action: "retry",
        attemptId: "attempt",
        reasons: ["Retry."],
        runId: "run",
        taskId: "task",
      }),
    ).toThrow("repair instruction");
    expect(() =>
      createCompletionDecision({
        action: "accepted",
        attemptId: "attempt",
        reasons: ["Accepted."],
        repairInstruction: {
          failedCheckIds: ["check"],
          feedback: "Unexpected.",
        },
        runId: "run",
        taskId: "task",
      }),
    ).toThrow("Only retry");
  });

  it("rejects malformed record versions, dates, evidence, and repair data", () => {
    const attempt = createEvalAttemptRecord({
      attemptId: "attempt",
      contextDigest: sha256Digest({ context: 1 }),
      finishedAt: "2026-08-13T00:00:01.000Z",
      planDigest: sha256Digest({ plan: 1 }),
      scorecardDigest: sha256Digest({ scorecard: 1 }),
      startedAt: "2026-08-13T00:00:00.000Z",
    });
    expect(() => validateEvalAttemptRecord({ ...attempt, version: 2 as 1 })).toThrow("Unsupported");
    expect(() => createEvalAttemptRecord({ ...attempt, startedAt: "invalid" })).toThrow(
      "valid date",
    );

    const evidence = {
      digest: sha256Digest({ evidence: 1 }),
      id: "evidence",
      metadata: {},
      ref: "evidence:ref",
      summary: "Evidence.",
      type: "output" as const,
      version: 1 as const,
    };
    const index = createEvalEvidenceIndex("attempt", [evidence]);
    expect(() => validateEvalEvidenceIndex({ ...index, version: 2 as 1 })).toThrow("Unsupported");
    for (const invalid of [
      { ...evidence, id: "" },
      { ...evidence, digest: "invalid" },
      { ...evidence, ref: "" },
      { ...evidence, summary: "" },
      { ...evidence, type: "invalid" },
      { ...evidence, metadata: { invalid: undefined } },
      { ...evidence, version: 2 },
    ]) {
      expect(() => createEvalEvidenceIndex("attempt", [invalid as typeof evidence])).toThrow();
    }

    const accepted = createCompletionDecision({
      action: "accepted",
      attemptId: "attempt",
      reasons: ["Accepted."],
      runId: "run",
      taskId: "task",
    });
    expect(() => validateCompletionDecision({ ...accepted, version: 2 as 1 })).toThrow(
      "Unsupported",
    );
    expect(() =>
      validateCompletionDecision({
        ...accepted,
        digest: sha256Digest({ different: true }),
      }),
    ).toThrow("digest");
    expect(() =>
      createCompletionDecision({
        action: "invalid" as "accepted",
        attemptId: "attempt",
        reasons: ["Invalid."],
        runId: "run",
        taskId: "task",
      }),
    ).toThrow("Invalid evaluation completion action");
    expect(() =>
      createCompletionDecision({
        action: "accepted",
        attemptId: "attempt",
        reasons: [],
        runId: "run",
        taskId: "task",
      }),
    ).toThrow("at least one reason");
    expect(() =>
      createCompletionDecision({
        action: "retry",
        attemptId: "attempt",
        reasons: ["Retry."],
        repairInstruction: {
          failedCheckIds: [],
          feedback: "Fix.",
        },
        runId: "run",
        taskId: "task",
      }),
    ).toThrow("at least one failed check");
    expect(() =>
      createCompletionDecision({
        action: "retry",
        attemptId: "attempt",
        reasons: ["Retry."],
        repairInstruction: {
          failedCheckIds: ["same", "same"],
          feedback: "Fix.",
        },
        runId: "run",
        taskId: "task",
      }),
    ).toThrow("duplicate");
  });
});
