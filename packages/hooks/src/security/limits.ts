import { HookConfigError } from "../errors.js";

export interface HookResourceLimits {
  readonly backgroundCloseTimeoutMs: number;
  readonly defaultAgentTimeoutMs: number;
  readonly defaultCommandTimeoutMs: number;
  readonly defaultHttpTimeoutMs: number;
  readonly defaultPromptTimeoutMs: number;
  readonly eventTimeoutMs: number;
  readonly maxConcurrentHandlers: number;
  readonly maxConfigBytes: number;
  readonly maxDepth: number;
  readonly maxAgentTokens: number;
  readonly maxAgentToolCalls: number;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly maxRedirects: number;
  readonly maxStopBlocks: number;
}

export const DEFAULT_HOOK_RESOURCE_LIMITS = Object.freeze({
  backgroundCloseTimeoutMs: 2_000,
  defaultAgentTimeoutMs: 60_000,
  defaultCommandTimeoutMs: 600_000,
  defaultHttpTimeoutMs: 30_000,
  defaultPromptTimeoutMs: 30_000,
  eventTimeoutMs: 600_000,
  maxConcurrentHandlers: 8,
  maxConfigBytes: 1_048_576,
  maxDepth: 1,
  maxAgentTokens: 32_768,
  maxAgentToolCalls: 100,
  maxInputBytes: 1_048_576,
  maxOutputBytes: 1_048_576,
  maxRedirects: 5,
  maxStopBlocks: 10,
} satisfies HookResourceLimits);

export class HookLimits implements HookResourceLimits {
  public readonly backgroundCloseTimeoutMs!: number;
  public readonly defaultAgentTimeoutMs!: number;
  public readonly defaultCommandTimeoutMs!: number;
  public readonly defaultHttpTimeoutMs!: number;
  public readonly defaultPromptTimeoutMs!: number;
  public readonly eventTimeoutMs!: number;
  public readonly maxConcurrentHandlers!: number;
  public readonly maxConfigBytes!: number;
  public readonly maxDepth!: number;
  public readonly maxAgentTokens!: number;
  public readonly maxAgentToolCalls!: number;
  public readonly maxInputBytes!: number;
  public readonly maxOutputBytes!: number;
  public readonly maxRedirects!: number;
  public readonly maxStopBlocks!: number;

  public constructor(overrides: Partial<HookResourceLimits> = {}) {
    Object.assign(this, DEFAULT_HOOK_RESOURCE_LIMITS, overrides);

    for (const [name, value] of Object.entries(this)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new HookConfigError(
          "HOOK_CONFIG_INVALID",
          `Hook resource limit ${name} must be a positive safe integer.`,
        );
      }
    }

    Object.freeze(this);
  }
}
