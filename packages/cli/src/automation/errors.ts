import { CLI_EXIT_CODES, type CliExitCode, type CliMachineStatus } from "../output/types.js";

export type CliAutomationErrorCode =
  | "CLI_APPROVAL_REQUIRED"
  | "CLI_INVALID_AUTOMATION_INPUT"
  | "CLI_NEEDS_INPUT"
  | "CLI_POLICY_DENIED"
  | "CLI_REVIEW_REQUIRED";

export interface CliAutomationErrorOptions {
  readonly capability?: string | undefined;
  readonly questionKey?: string | undefined;
}

export class CliAutomationError extends Error {
  public override readonly name = "CliAutomationError";

  public constructor(
    public readonly code: CliAutomationErrorCode,
    message: string,
    public readonly status: Exclude<CliMachineStatus, "completed">,
    public readonly exitCode: CliExitCode,
    public readonly details: CliAutomationErrorOptions = {},
  ) {
    super(message);
  }
}

export function invalidAutomationInput(message: string): CliAutomationError {
  return new CliAutomationError(
    "CLI_INVALID_AUTOMATION_INPUT",
    message,
    "failed",
    CLI_EXIT_CODES.INVALID_ARGUMENT,
  );
}

export function needsInput(message: string, questionKey?: string): CliAutomationError {
  return new CliAutomationError(
    "CLI_NEEDS_INPUT",
    message,
    "needs-input",
    CLI_EXIT_CODES.NEEDS_INPUT,
    questionKey === undefined ? {} : { questionKey },
  );
}

export function approvalRequired(message: string, capability?: string): CliAutomationError {
  return new CliAutomationError(
    "CLI_APPROVAL_REQUIRED",
    message,
    "needs-input",
    CLI_EXIT_CODES.APPROVAL_REQUIRED,
    capability === undefined ? {} : { capability },
  );
}

export function policyDenied(message: string, capability?: string): CliAutomationError {
  return new CliAutomationError(
    "CLI_POLICY_DENIED",
    message,
    "failed",
    CLI_EXIT_CODES.POLICY_DENIED,
    capability === undefined ? {} : { capability },
  );
}
