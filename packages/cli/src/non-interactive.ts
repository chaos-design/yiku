import {
  type AgentProgressEvent,
  AgentStageStopError,
  EvaluationGateError,
  type EvaluationOutcome,
  SessionPausedError,
  type WorkspaceAccessMode,
} from "@yiku/agent-orchestrator";
import {
  CliAgentSession,
  type CliAgentSessionContract,
  type executeAgentSession,
} from "./agent-session.js";
import {
  isCliAutomationError,
  loadNonInteractiveAutomation,
  type NonInteractiveAutomation,
} from "./automation/index.js";
import {
  CLI_EXIT_CODES,
  type CliMachineDiagnostic,
  type CliMachineError,
  type CliMachineOutputWriter,
  type CliMachineStatus,
  type CliOutputFormat,
  JsonOutputWriter,
  NdjsonOutputWriter,
} from "./output/index.js";

type ExecuteSession = typeof executeAgentSession;

type NonInteractiveQuestionHandler = NonNullable<
  Parameters<CliAgentSessionContract["submit"]>[1]
>["userQuestionHandler"];

export interface RunNonInteractivePromptOptions {
  readonly accessMode?: WorkspaceAccessMode | undefined;
  readonly agentSession?: CliAgentSessionContract | undefined;
  readonly agentKey?: string | undefined;
  readonly answersFilePath?: string | undefined;
  readonly auditFilePath?: string | undefined;
  readonly automation?: NonInteractiveAutomation | undefined;
  readonly continueSession?: boolean | undefined;
  readonly homeDir?: string | undefined;
  readonly initOnly?: boolean | undefined;
  readonly outputFormat?: CliOutputFormat | undefined;
  readonly policyFilePath?: string | undefined;
  readonly prompt: string;
  readonly runPromptImpl?: ExecuteSession | undefined;
  readonly resumeSessionId?: string | undefined;
  readonly setupMode?: "init" | "maintenance" | undefined;
  readonly stderr?: NodeJS.WriteStream | undefined;
  readonly stdout?: NodeJS.WriteStream | undefined;
  readonly workspaceDir?: string | undefined;
}

export async function runNonInteractivePrompt(
  options: RunNonInteractivePromptOptions,
): Promise<number> {
  const stderr = options.stderr ?? process.stderr;
  const stdout = options.stdout ?? process.stdout;
  const outputFormat = options.outputFormat ?? "text";
  const machineOutput = createMachineOutputWriter(outputFormat, stdout);
  let automation = options.automation;
  let interactionFailure: unknown;
  let evaluationEvent:
    | Extract<AgentProgressEvent, { readonly type: "evaluation_finished" }>
    | undefined;
  const onEvent = (event: AgentProgressEvent) => {
    machineOutput?.observe(event);
    if (event.type === "evaluation_finished") {
      evaluationEvent = event;
    }
  };

  const resumeRequested = options.continueSession === true || options.resumeSessionId !== undefined;
  const prompt =
    options.prompt || (resumeRequested ? "Continue working from the saved Session." : "");

  if (!prompt && options.initOnly !== true) {
    const error = Object.assign(
      new Error('Provide a prompt argument, for example: yiku "your prompt".'),
      { code: "CLI_INVALID_ARGUMENT" },
    );
    writeFailure(stderr, machineOutput, error, undefined, []);
    return CLI_EXIT_CODES.INVALID_ARGUMENT;
  }

  try {
    automation ??= await loadNonInteractiveAutomation({
      accessMode: options.accessMode ?? "read-only",
      ...(options.answersFilePath === undefined
        ? {}
        : { answersFilePath: options.answersFilePath }),
      ...(options.auditFilePath === undefined ? {} : { auditFilePath: options.auditFilePath }),
      ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
      ...(options.policyFilePath === undefined ? {} : { policyFilePath: options.policyFilePath }),
      workspaceDir: options.workspaceDir ?? process.cwd(),
    });
    const activeAutomation = automation;
    const interactionAbort = new AbortController();
    const captureInteractionFailure = (error: unknown): void => {
      if (!isCliAutomationError(error)) {
        return;
      }
      interactionFailure ??= error;
      if (!interactionAbort.signal.aborted) {
        interactionAbort.abort(error);
      }
    };
    const resolveQuestion: NonInteractiveQuestionHandler = async (request) => {
      try {
        return await activeAutomation.questionHandler()(request);
      } catch (error) {
        captureInteractionFailure(error);
        throw error;
      }
    };
    const configuredPermissionApprovalHandler = activeAutomation.permissionApprovalHandler();
    const permissionApprovalHandler: typeof configuredPermissionApprovalHandler = async (
      request,
    ) => {
      try {
        return await configuredPermissionApprovalHandler(request);
      } catch (error) {
        captureInteractionFailure(error);
        throw error;
      }
    };
    const configuredPermissionAssessmentHandler = activeAutomation.permissionAssessmentHandler();
    const permissionAssessmentHandler: typeof configuredPermissionAssessmentHandler = async (
      request,
      assessment,
    ) => {
      try {
        return await configuredPermissionAssessmentHandler(request, assessment);
      } catch (error) {
        captureInteractionFailure(error);
        throw error;
      }
    };
    const configuredWorkspaceAccessApprovalHandler =
      activeAutomation.workspaceAccessApprovalHandler();
    const workspaceAccessApprovalHandler: typeof configuredWorkspaceAccessApprovalHandler = async (
      request,
    ) => {
      try {
        return await configuredWorkspaceAccessApprovalHandler(request);
      } catch (error) {
        captureInteractionFailure(error);
        throw error;
      }
    };
    let output: string;
    let evaluation: EvaluationOutcome | undefined;
    if (options.setupMode !== undefined || resumeRequested) {
      const session =
        options.agentSession ??
        new CliAgentSession({
          accessMode: options.accessMode ?? "read-only",
          ...(options.agentKey !== undefined ? { agentKey: options.agentKey } : {}),
          ...(options.continueSession !== undefined
            ? { continueSession: options.continueSession }
            : {}),
          ...(options.resumeSessionId !== undefined
            ? { resumeSessionId: options.resumeSessionId }
            : {}),
          ...(options.runPromptImpl !== undefined
            ? { runAgentSessionImpl: options.runPromptImpl }
            : {}),
          permissionPolicyMode: "external",
        });
      try {
        if (options.setupMode !== undefined) {
          await session.setup(options.setupMode);
        }
        if (options.initOnly === true) {
          const diagnostics = activeAutomation.diagnostics();
          writeDiagnostics(stderr, diagnostics);
          writeSuccess(
            stdout,
            machineOutput,
            "Setup completed.",
            undefined,
            undefined,
            diagnostics,
          );
          return CLI_EXIT_CODES.SUCCESS;
        }
        output = await session.submit(prompt, {
          mcpElicitationHandler: () => ({ action: "decline" }),
          onEvent,
          permissionApprovalHandler,
          permissionAssessmentHandler,
          signal: interactionAbort.signal,
          userQuestionHandler: resolveQuestion,
          workspaceAccessApprovalHandler,
        });
        if (interactionFailure !== undefined) {
          throw interactionFailure;
        }
        evaluation = session.evaluationOutcome?.();
      } finally {
        await session.close("prompt_input_exit");
      }
    } else {
      const session =
        options.agentSession ??
        new CliAgentSession({
          accessMode: options.accessMode ?? "read-only",
          ...(options.agentKey !== undefined ? { agentKey: options.agentKey } : {}),
          permissionPolicyMode: "external",
          ...(options.runPromptImpl === undefined
            ? {}
            : { runAgentSessionImpl: options.runPromptImpl }),
        });
      try {
        output = await session.submit(prompt, {
          mcpElicitationHandler: () => ({ action: "decline" }),
          onEvent,
          permissionApprovalHandler,
          permissionAssessmentHandler,
          signal: interactionAbort.signal,
          userQuestionHandler: resolveQuestion,
          workspaceAccessApprovalHandler,
        });
        if (interactionFailure !== undefined) {
          throw interactionFailure;
        }
        evaluation = session.evaluationOutcome?.();
      } finally {
        await session.close("prompt_input_exit");
      }
    }
    const diagnostics = activeAutomation.diagnostics();
    writeDiagnostics(stderr, diagnostics);
    writeSuccess(stdout, machineOutput, output, evaluation, evaluationEvent, diagnostics);

    return successExitCode(evaluation);
  } catch (error) {
    const effectiveError = interactionFailure ?? error;
    const outcome = error instanceof EvaluationGateError ? error.outcome : undefined;
    const diagnostics = automation?.diagnostics() ?? [];
    writeDiagnostics(stderr, diagnostics);
    writeFailure(stderr, machineOutput, effectiveError, outcome, diagnostics);
    return errorExitCode(effectiveError, outcome);
  }
}

function writeSuccess(
  stdout: NodeJS.WriteStream,
  machineOutput: CliMachineOutputWriter | undefined,
  output: string,
  evaluation: EvaluationOutcome | undefined,
  event: Extract<AgentProgressEvent, { readonly type: "evaluation_finished" }> | undefined,
  diagnostics: readonly CliMachineDiagnostic[],
): void {
  if (machineOutput !== undefined) {
    machineOutput.writeSuccess({
      diagnostics,
      ...(evaluation === undefined ? {} : { evaluation }),
      output,
    });
    return;
  }
  stdout.write(`${output || "(empty output)"}\n`);
  if (event !== undefined) {
    stdout.write(
      `Evaluation: ${event.decision} · ${event.grade} · ${(event.overallScore * 100).toFixed(1)} · ${event.counts.passed} passed, ${event.counts.failed} failed, ${event.counts.error} error, ${event.counts["not-run"]} not-run\n`,
    );
  }
}

function evaluationErrorCode(error: unknown): string {
  return isCliAutomationError(error)
    ? error.code
    : isReviewRequiredError(error)
      ? "CLI_REVIEW_REQUIRED"
      : isPermissionDeniedError(error)
        ? "CLI_POLICY_DENIED"
        : error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : error instanceof EvaluationGateError
            ? `EVAL_${error.outcome.decision.action.toUpperCase().replaceAll("-", "_")}`
            : "CLI_EXECUTION_FAILED";
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeFailure(
  stderr: NodeJS.WriteStream,
  machineOutput: CliMachineOutputWriter | undefined,
  error: unknown,
  outcome: EvaluationOutcome | undefined,
  diagnostics: readonly CliMachineDiagnostic[],
): void {
  const machineError: CliMachineError = {
    code: evaluationErrorCode(error),
    ...(isCliAutomationError(error) ? error.details : {}),
    message: getErrorMessage(error),
  };
  if (machineOutput !== undefined) {
    machineOutput.writeFailure({
      diagnostics,
      error: machineError,
      ...(outcome === undefined ? {} : { evaluation: outcome }),
      status: failureStatus(error, outcome),
    });
    return;
  }
  stderr.write(`Error: ${getErrorMessage(error)}\n`);
}

function errorExitCode(error: unknown, outcome: EvaluationOutcome | undefined): number {
  if (isCliAutomationError(error)) {
    return error.exitCode;
  }
  if (isPermissionDeniedError(error)) {
    return CLI_EXIT_CODES.POLICY_DENIED;
  }
  if (isReviewRequiredError(error)) {
    return CLI_EXIT_CODES.NEEDS_REVIEW;
  }
  if (isPausedError(error)) {
    return CLI_EXIT_CODES.BUDGET_PAUSED;
  }
  if (isExternalDependencyError(error)) {
    return CLI_EXIT_CODES.EXTERNAL_DEPENDENCY_FAILED;
  }
  return outcome?.decision.action === "needs-review" || outcome?.decision.action === "retry"
    ? CLI_EXIT_CODES.NEEDS_REVIEW
    : outcome?.decision.action === "rejected"
      ? CLI_EXIT_CODES.VERIFICATION_FAILED
      : CLI_EXIT_CODES.EXECUTION_FAILED;
}

function writeDiagnostics(
  stderr: NodeJS.WriteStream,
  diagnostics: readonly CliMachineDiagnostic[],
): void {
  for (const diagnostic of diagnostics) {
    stderr.write(`Warning: ${diagnostic.message}\n`);
  }
}

function isPermissionDeniedError(error: unknown): boolean {
  return error instanceof Error && error.name === "PermissionDeniedError";
}

function createMachineOutputWriter(
  format: CliOutputFormat,
  stdout: NodeJS.WriteStream,
): CliMachineOutputWriter | undefined {
  switch (format) {
    case "json":
      return new JsonOutputWriter(stdout);
    case "ndjson":
      return new NdjsonOutputWriter(stdout);
    case "text":
      return undefined;
  }
}

function failureStatus(
  error: unknown,
  outcome: EvaluationOutcome | undefined,
): Exclude<CliMachineStatus, "completed"> {
  if (isCliAutomationError(error)) {
    return error.status;
  }
  if (isReviewRequiredError(error)) {
    return "needs-review";
  }
  if (isPausedError(error)) {
    return "paused";
  }
  return outcome?.decision.action === "needs-review" || outcome?.decision.action === "retry"
    ? "needs-review"
    : "failed";
}

function isPausedError(error: unknown): boolean {
  return error instanceof SessionPausedError || error instanceof AgentStageStopError;
}

function isReviewRequiredError(error: unknown): boolean {
  return error instanceof SessionPausedError && error.reason === "needs-review";
}

function isExternalDependencyError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string") {
    return false;
  }
  return (
    error.code.includes("PROVIDER") ||
    error.code === "MCP_CONNECTION_FAILED" ||
    error.code === "MCP_INVOCATION_FAILED"
  );
}

function successExitCode(evaluation: EvaluationOutcome | undefined): number {
  switch (evaluation?.decision.action) {
    case "needs-review":
    case "retry":
      return CLI_EXIT_CODES.NEEDS_REVIEW;
    case "rejected":
      return CLI_EXIT_CODES.VERIFICATION_FAILED;
    case "accepted":
    case "degraded":
    case undefined:
      return CLI_EXIT_CODES.SUCCESS;
  }
}
