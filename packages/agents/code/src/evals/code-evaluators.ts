import {
  createDefaultEvalProfile,
  DEFAULT_CHECK_EVALUATORS,
  type EvalCheckDefinition,
  type EvalCheckEvaluator,
  type EvalCheckResult,
  type EvalExecutionContext,
  type EvalPolicyMode,
  type EvalProfile,
  EvaluationError,
  type PlannedEvalCheck,
  sha256Digest,
  type VerificationCommand,
} from "@yiku/evals";
import type { VerificationCommandRunner } from "./verification-command-runner.js";

export class CodeArtifactIntegrityEvaluator implements EvalCheckEvaluator {
  public readonly descriptor = Object.freeze({
    capability: "code-artifact-integrity",
    deterministic: true,
    key: "code-artifact-integrity",
    label: "Code Artifact Integrity",
    version: "1.0.0",
  });

  public evaluate(check: PlannedEvalCheck, context: EvalExecutionContext): EvalCheckResult {
    const artifacts = context.artifacts.filter((artifact) => artifact.kind === "file-change");
    const paths = new Set<string>();
    const issues: string[] = [];
    for (const artifact of artifacts) {
      const path = stringMetadata(artifact.metadata.path);
      if (path === undefined || paths.has(path)) {
        issues.push(
          path === undefined ? `invalid artifact ${artifact.id}` : `duplicate path ${path}`,
        );
      } else {
        paths.add(path);
      }
      if (sha256Digest(artifact.metadata) !== artifact.digest) {
        issues.push(`digest mismatch ${artifact.id}`);
      }
    }
    return result(
      check,
      this.descriptor.label,
      issues.length === 0,
      issues.length === 0
        ? `${artifacts.length} code artifacts are internally consistent.`
        : issues.join("; "),
      artifacts.map((artifact) => artifact.storageRef),
      false,
    );
  }
}

export class CodeChangeScopeEvaluator implements EvalCheckEvaluator {
  public readonly descriptor = Object.freeze({
    capability: "code-change-scope",
    deterministic: true,
    key: "code-change-scope",
    label: "Code Change Scope",
    version: "1.0.0",
  });

  public evaluate(check: PlannedEvalCheck, context: EvalExecutionContext): EvalCheckResult {
    const artifacts = context.artifacts.filter((artifact) => artifact.kind === "file-change");
    const requireChanges = check.config.requireChanges !== false;
    const violations = artifacts.filter(
      (artifact) =>
        artifact.metadata.inScope !== true || artifact.metadata.externalSymlink === true,
    );
    const passed = violations.length === 0 && (!requireChanges || artifacts.length > 0);
    const summary =
      violations.length > 0
        ? `Out-of-scope code artifacts: ${violations
            .map((artifact) => String(artifact.metadata.path ?? artifact.id))
            .join(", ")}.`
        : artifacts.length === 0
          ? "No code changes were captured."
          : `${artifacts.length} code changes stay within the configured scope.`;
    return result(
      check,
      this.descriptor.label,
      passed,
      summary,
      artifacts.map((artifact) => artifact.storageRef),
      false,
    );
  }
}

export class CodeVerificationCommandEvaluator implements EvalCheckEvaluator {
  public readonly descriptor = Object.freeze({
    capability: "code-verification-command",
    deterministic: true,
    key: "code-verification-command",
    label: "Code Verification Command",
    version: "1.0.0",
  });

  public constructor(private readonly runner: VerificationCommandRunner) {}

  public async evaluate(
    check: PlannedEvalCheck,
    context: EvalExecutionContext,
  ): Promise<EvalCheckResult> {
    const command = parseVerificationCommand(check.config.command);
    const execution = await this.runner.run(command, context.signal);
    const passed =
      execution.exitCode === 0 && execution.signal === undefined && !execution.timedOut;
    const errorCode = execution.timedOut
      ? "EVAL_TIMEOUT"
      : execution.signal !== undefined
        ? "EVAL_COMMAND_SIGNALLED"
        : passed
          ? undefined
          : "EVAL_COMMAND_FAILED";
    const output = [
      execution.stdoutHead,
      execution.stdoutTail,
      execution.stderrHead,
      execution.stderrTail,
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 8_000);
    return Object.freeze({
      dimension: check.dimension,
      durationMs: execution.durationMs,
      ...(errorCode !== undefined ? { errorCode } : {}),
      evaluator: check.evaluator,
      evidenceRefs: Object.freeze([execution.artifact.storageRef]),
      ...(output ? { feedback: output } : {}),
      id: check.id,
      label: `${this.descriptor.label}: ${command.id}`,
      passed,
      required: check.required,
      resourceUsage: Object.freeze({
        outputBytes: execution.artifact.sizeBytes,
      }),
      retryable: !passed && !execution.timedOut,
      score: passed ? 1 : 0,
      severity: check.severity,
      status: passed ? "passed" : execution.timedOut ? "error" : "failed",
      summary: passed
        ? `Verification command ${command.id} passed.`
        : `Verification command ${command.id} did not pass.`,
      version: 1,
    });
  }
}

export interface CodeEvalProfileOptions {
  readonly commands: readonly VerificationCommand[];
  readonly id?: string | undefined;
  readonly maxConcurrentChecks?: number | undefined;
  readonly maxRepairAttempts?: 0 | 1 | undefined;
  readonly mode?: EvalPolicyMode | undefined;
  readonly qualityThreshold?: number | undefined;
  readonly requireChanges?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
}

export function createCodeEvalProfile(options: CodeEvalProfileOptions): EvalProfile {
  const generic = createDefaultEvalProfile({
    id: options.id ?? "code-default",
    ...(options.maxConcurrentChecks !== undefined
      ? { maxConcurrentChecks: options.maxConcurrentChecks }
      : {}),
    ...(options.maxRepairAttempts !== undefined
      ? { maxRepairAttempts: options.maxRepairAttempts }
      : {}),
    mode: options.mode ?? "enforce",
    ...(options.qualityThreshold !== undefined
      ? { qualityThreshold: options.qualityThreshold }
      : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  const commandIds = new Set<string>();
  const commandChecks = options.commands.map((input): EvalCheckDefinition => {
    const command = parseVerificationCommand(input);
    if (commandIds.has(command.id)) {
      throw new EvaluationError(
        "EVAL_PROFILE_INVALID",
        `Duplicate verification command ID: ${command.id}.`,
      );
    }
    commandIds.add(command.id);
    return Object.freeze({
      capability: "code-verification-command",
      concurrencyGroup: "code-verification-command",
      config: Object.freeze({
        command: Object.freeze({
          ...command,
          args: Object.freeze([...command.args]),
          envAllowlist: Object.freeze([...command.envAllowlist]),
        }),
      }),
      dependsOn: Object.freeze(["code-artifact-integrity", "code-change-scope"]),
      dimension: "correctness",
      evaluator: "code-verification-command",
      evidenceRequired: true,
      id: `code-${command.id}`,
      required: true,
      severity: "error",
      timeoutMs: command.timeoutMs,
      weight: 1,
    });
  });
  return Object.freeze({
    ...generic,
    checks: Object.freeze([
      ...generic.checks,
      Object.freeze({
        capability: "code-artifact-integrity",
        config: Object.freeze({}),
        dependsOn: Object.freeze([]),
        dimension: "correctness",
        evaluator: "code-artifact-integrity",
        evidenceRequired: false,
        id: "code-artifact-integrity",
        required: true,
        severity: "error",
        timeoutMs: 30_000,
        weight: 1,
      }),
      Object.freeze({
        capability: "code-change-scope",
        config: Object.freeze({
          requireChanges: options.requireChanges ?? true,
        }),
        dependsOn: Object.freeze(["code-artifact-integrity"]),
        dimension: "safety-reliability",
        evaluator: "code-change-scope",
        evidenceRequired: false,
        id: "code-change-scope",
        required: true,
        severity: "blocker",
        timeoutMs: 30_000,
        weight: 1,
      }),
      ...commandChecks,
    ]),
  });
}

export function createCodeEvaluators(
  runner: VerificationCommandRunner,
): readonly EvalCheckEvaluator[] {
  return Object.freeze([
    ...DEFAULT_CHECK_EVALUATORS,
    new CodeArtifactIntegrityEvaluator(),
    new CodeChangeScopeEvaluator(),
    new CodeVerificationCommandEvaluator(runner),
  ]);
}

function result(
  check: PlannedEvalCheck,
  label: string,
  passed: boolean,
  summary: string,
  evidenceRefs: readonly string[],
  retryable: boolean,
): EvalCheckResult {
  return Object.freeze({
    dimension: check.dimension,
    durationMs: 0,
    evaluator: check.evaluator,
    evidenceRefs: Object.freeze([...evidenceRefs]),
    id: check.id,
    label,
    passed,
    required: check.required,
    retryable,
    score: passed ? 1 : 0,
    severity: check.severity,
    status: passed ? "passed" : "failed",
    summary,
    version: 1,
  });
}

function parseVerificationCommand(value: unknown): VerificationCommand {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EvaluationError(
      "EVAL_PROFILE_INVALID",
      "Verification command config must be an object.",
    );
  }
  const command = value as Partial<VerificationCommand>;
  if (
    !Array.isArray(command.args) ||
    command.args.some((argument) => typeof argument !== "string") ||
    typeof command.command !== "string" ||
    typeof command.cwd !== "string" ||
    !Array.isArray(command.envAllowlist) ||
    command.envAllowlist.some((name) => typeof name !== "string") ||
    typeof command.id !== "string" ||
    (command.network !== "allowlist" && command.network !== "deny") ||
    !Number.isSafeInteger(command.timeoutMs) ||
    (command.writePolicy !== "isolated" && command.writePolicy !== "read-only")
  ) {
    throw new EvaluationError("EVAL_PROFILE_INVALID", "Verification command config is invalid.");
  }
  return command as VerificationCommand;
}

function stringMetadata(value: boolean | number | string | undefined): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
