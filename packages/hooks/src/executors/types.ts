import type { HookExecutionResult, HookExecutor, HookExecutorType } from "../types.js";

export interface HookExecutorRegistryView {
  get(type: HookExecutorType): HookExecutor;
  has(type: HookExecutorType): boolean;
  list(): readonly HookExecutorType[];
}

export interface HookDispatchExecution {
  readonly hookId: string;
  readonly result: HookExecutionResult;
}
