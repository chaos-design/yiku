import { canonicalStringify, sha256Digest } from "./canonical.js";
import { EvaluationError, unsupportedEvaluationVersion } from "./errors.js";
import type {
  CompletionDecision,
  CompletionDecisionAction,
  EvalAttemptRecord,
  EvalEvidence,
  EvalEvidenceIndex,
  RepairInstruction,
} from "./types.js";
import {
  MAX_EVAL_FEEDBACK_CHARACTERS,
  MAX_EVAL_SUMMARY_CHARACTERS,
  requireDigest,
  requireIdentifier,
} from "./validation.js";

export interface CreateEvalAttemptRecordInput {
  readonly attemptId: string;
  readonly contextDigest: string;
  readonly finishedAt: string;
  readonly planDigest: string;
  readonly scorecardDigest: string;
  readonly startedAt: string;
}

export interface CreateCompletionDecisionInput {
  readonly action: CompletionDecisionAction;
  readonly attemptId: string;
  readonly reasons: readonly string[];
  readonly repairInstruction?: RepairInstruction | undefined;
  readonly runId: string;
  readonly taskId: string;
}

export function createEvalAttemptRecord(input: CreateEvalAttemptRecordInput): EvalAttemptRecord {
  const semantic = {
    attemptId: requireIdentifier(input.attemptId, "Evaluation attempt ID"),
    contextDigest: requireDigest(input.contextDigest, "Evaluation context digest"),
    finishedAt: requireDate(input.finishedAt, "Evaluation attempt finishedAt"),
    planDigest: requireDigest(input.planDigest, "Evaluation plan digest"),
    scorecardDigest: requireDigest(input.scorecardDigest, "Evaluation scorecard digest"),
    startedAt: requireDate(input.startedAt, "Evaluation attempt startedAt"),
    version: 1 as const,
  };
  if (Date.parse(semantic.finishedAt) < Date.parse(semantic.startedAt)) {
    throw new EvaluationError(
      "EVAL_INVALID_RESULT",
      "Evaluation attempt finishedAt must not precede startedAt.",
    );
  }
  return Object.freeze({
    ...semantic,
    digest: sha256Digest(semantic, {
      code: "EVAL_INVALID_RESULT",
      label: "Evaluation attempt",
    }),
  });
}

export function validateEvalAttemptRecord(record: EvalAttemptRecord): void {
  if (record.version !== 1) {
    throw unsupportedEvaluationVersion("attempt", record.version);
  }
  const expected = createEvalAttemptRecord(record);
  if (expected.digest !== record.digest) {
    throw invalid("Evaluation attempt digest does not match its contents.");
  }
}

export function createEvalEvidenceIndex(
  attemptId: string,
  evidence: readonly EvalEvidence[],
): EvalEvidenceIndex {
  const ids = new Set<string>();
  const normalized = evidence.map((item) => {
    validateEvidence(item);
    if (ids.has(item.id)) {
      throw invalid(`Duplicate evaluation evidence ID: ${item.id}.`);
    }
    ids.add(item.id);
    return Object.freeze({
      ...item,
      metadata: Object.freeze({ ...item.metadata }),
    });
  });
  const semantic = {
    attemptId: requireIdentifier(attemptId, "Evaluation attempt ID"),
    evidence: normalized,
    version: 1 as const,
  };
  return Object.freeze({
    ...semantic,
    digest: sha256Digest(semantic, {
      code: "EVAL_INVALID_RESULT",
      label: "Evaluation evidence index",
    }),
    evidence: Object.freeze(normalized),
  });
}

export function validateEvalEvidenceIndex(index: EvalEvidenceIndex): void {
  if (index.version !== 1) {
    throw unsupportedEvaluationVersion("evidence index", index.version);
  }
  const expected = createEvalEvidenceIndex(index.attemptId, index.evidence);
  if (expected.digest !== index.digest) {
    throw invalid("Evaluation evidence index digest does not match its contents.");
  }
}

export function createCompletionDecision(input: CreateCompletionDecisionInput): CompletionDecision {
  const action = requireAction(input.action);
  const reasons = input.reasons.map((reason, index) =>
    requireText(reason, `Evaluation decision reason ${index + 1}`, MAX_EVAL_SUMMARY_CHARACTERS),
  );
  if (reasons.length === 0) {
    throw invalid("Evaluation decision must contain at least one reason.");
  }
  const repairInstruction = normalizeRepairInstruction(input.repairInstruction);
  if (action === "retry" && repairInstruction === undefined) {
    throw invalid("Retry decisions must contain a repair instruction.");
  }
  if (action !== "retry" && repairInstruction !== undefined) {
    throw invalid("Only retry decisions can contain a repair instruction.");
  }
  const semantic = {
    action,
    attemptId: requireIdentifier(input.attemptId, "Evaluation attempt ID"),
    reasons: Object.freeze(reasons),
    ...(repairInstruction !== undefined ? { repairInstruction } : {}),
    runId: requireIdentifier(input.runId, "Evaluation run ID"),
    taskId: requireIdentifier(input.taskId, "Evaluation task ID"),
    version: 1 as const,
  };
  return Object.freeze({
    ...semantic,
    digest: sha256Digest(semantic, {
      code: "EVAL_INVALID_RESULT",
      label: "Evaluation completion decision",
    }),
  });
}

export function validateCompletionDecision(decision: CompletionDecision): void {
  if (decision.version !== 1) {
    throw unsupportedEvaluationVersion("completion decision", decision.version);
  }
  const expected = createCompletionDecision(decision);
  if (expected.digest !== decision.digest) {
    throw invalid("Evaluation completion decision digest does not match its contents.");
  }
}

function validateEvidence(evidence: EvalEvidence): void {
  if (evidence.version !== 1) {
    throw unsupportedEvaluationVersion("evidence", evidence.version);
  }
  requireIdentifier(evidence.id, "Evaluation evidence ID");
  requireDigest(evidence.digest, `Evaluation evidence ${evidence.id} digest`);
  requireText(evidence.ref, `Evaluation evidence ${evidence.id} reference`, 2_048);
  requireText(
    evidence.summary,
    `Evaluation evidence ${evidence.id} summary`,
    MAX_EVAL_SUMMARY_CHARACTERS,
  );
  if (
    !["artifact", "command", "flow", "output", "receipt", "research", "resource"].includes(
      evidence.type,
    )
  ) {
    throw invalid(`Evaluation evidence ${evidence.id} has an invalid type.`);
  }
  canonicalStringify(evidence.metadata, {
    code: "EVAL_INVALID_RESULT",
    label: `Evaluation evidence ${evidence.id} metadata`,
  });
}

function normalizeRepairInstruction(
  instruction: RepairInstruction | undefined,
): RepairInstruction | undefined {
  if (instruction === undefined) {
    return undefined;
  }
  if (instruction.failedCheckIds.length === 0) {
    throw invalid("Repair instruction must contain at least one failed check.");
  }
  const failedCheckIds = instruction.failedCheckIds.map((id) =>
    requireIdentifier(id, "Repair failed check ID"),
  );
  if (new Set(failedCheckIds).size !== failedCheckIds.length) {
    throw invalid("Repair instruction contains duplicate failed check IDs.");
  }
  return Object.freeze({
    failedCheckIds: Object.freeze(failedCheckIds),
    feedback: requireText(instruction.feedback, "Repair feedback", MAX_EVAL_FEEDBACK_CHARACTERS),
  });
}

function requireAction(action: CompletionDecisionAction): CompletionDecisionAction {
  if (!["accepted", "degraded", "needs-review", "rejected", "retry"].includes(action)) {
    throw invalid(`Invalid evaluation completion action: ${String(action)}.`);
  }
  return action;
}

function requireDate(value: string, label: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw invalid(`${label} must be a valid date.`);
  }
  return new Date(timestamp).toISOString();
}

function requireText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw invalid(`${label} must contain between 1 and ${maximum} characters.`);
  }
  return normalized;
}

function invalid(message: string): EvaluationError {
  return new EvaluationError("EVAL_INVALID_RESULT", message);
}
