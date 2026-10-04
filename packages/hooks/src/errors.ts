import type { HookEventName, HookExecutorType, HookSourceType } from "./types.js";

export type HookErrorCode =
  | "HOOK_ABORTED"
  | "HOOK_CAPABILITY_UNAVAILABLE"
  | "HOOK_CONFIG_INVALID"
  | "HOOK_DECISION_CONFLICT"
  | "HOOK_EXECUTION_FAILED"
  | "HOOK_MATCHER_INVALID"
  | "HOOK_PROTOCOL_INVALID"
  | "HOOK_SECURITY_REJECTED"
  | "HOOK_TIMEOUT"
  | "HOOK_TRUST_REQUIRED";

export interface HookErrorContext {
  readonly eventName?: HookEventName | undefined;
  readonly executorType?: HookExecutorType | undefined;
  readonly hookId?: string | undefined;
  readonly retryable?: boolean | undefined;
  readonly sourceType?: HookSourceType | undefined;
}

export interface HookErrorOptions extends ErrorOptions, HookErrorContext {}

export interface SerializedHookError {
  readonly code: HookErrorCode;
  readonly eventName?: HookEventName | undefined;
  readonly executorType?: HookExecutorType | undefined;
  readonly hookId?: string | undefined;
  readonly message: string;
  readonly name: string;
  readonly retryable: boolean;
  readonly sourceType?: HookSourceType | undefined;
}

export class HookError extends Error {
  public override readonly name: string = "HookError";
  public readonly code: HookErrorCode;
  public readonly eventName?: HookEventName | undefined;
  public readonly executorType?: HookExecutorType | undefined;
  public readonly hookId?: string | undefined;
  public readonly retryable: boolean;
  public readonly sourceType?: HookSourceType | undefined;

  public constructor(code: HookErrorCode, message: string, options: HookErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.eventName = options.eventName;
    this.executorType = options.executorType;
    this.hookId = options.hookId;
    this.retryable = options.retryable ?? false;
    this.sourceType = options.sourceType;
  }

  public toJSON(): SerializedHookError {
    return {
      code: this.code,
      ...(this.eventName !== undefined ? { eventName: this.eventName } : {}),
      ...(this.executorType !== undefined ? { executorType: this.executorType } : {}),
      ...(this.hookId !== undefined ? { hookId: this.hookId } : {}),
      message: this.message,
      name: this.name,
      retryable: this.retryable,
      ...(this.sourceType !== undefined ? { sourceType: this.sourceType } : {}),
    };
  }
}

export class HookConfigError extends HookError {
  public override readonly name = "HookConfigError";
}

export class HookTrustError extends HookError {
  public override readonly name = "HookTrustError";
}

export class HookMatcherError extends HookError {
  public override readonly name = "HookMatcherError";
}

export class HookExecutionError extends HookError {
  public override readonly name = "HookExecutionError";
}

export class HookTimeoutError extends HookError {
  public override readonly name = "HookTimeoutError";
}

export class HookProtocolError extends HookError {
  public override readonly name = "HookProtocolError";
}

export class HookDecisionConflictError extends HookError {
  public override readonly name = "HookDecisionConflictError";
}

export class HookCapabilityError extends HookError {
  public override readonly name = "HookCapabilityError";
}

export class HookSecurityError extends HookError {
  public override readonly name = "HookSecurityError";
}

export function asHookError(
  error: unknown,
  code: HookErrorCode,
  fallbackMessage: string,
  context: HookErrorContext = {},
): HookError {
  if (error instanceof HookError) {
    return error;
  }

  return new HookError(code, fallbackMessage, {
    cause: error,
    ...context,
  });
}
