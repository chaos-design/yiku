import { HookCapabilityError, HookConfigError } from "../errors.js";
import type { HookExecutor, HookExecutorType } from "../types.js";
import type { HookExecutorRegistryView } from "./types.js";

export class HookExecutorRegistry implements HookExecutorRegistryView {
  private readonly executors = new Map<HookExecutorType, HookExecutor>();

  public constructor(executors: readonly HookExecutor[] = []) {
    for (const executor of executors) {
      this.register(executor);
    }
  }

  public get(type: HookExecutorType): HookExecutor {
    const executor = this.executors.get(type);

    if (executor === undefined) {
      throw new HookCapabilityError(
        "HOOK_CAPABILITY_UNAVAILABLE",
        `Hook executor is not configured: ${type}.`,
        { executorType: type },
      );
    }

    return executor;
  }

  public has(type: HookExecutorType): boolean {
    return this.executors.has(type);
  }

  public list(): readonly HookExecutorType[] {
    return Object.freeze([...this.executors.keys()].sort());
  }

  public register(executor: HookExecutor): void {
    if (this.executors.has(executor.type)) {
      throw new HookConfigError(
        "HOOK_CONFIG_INVALID",
        `Hook executor is already registered: ${executor.type}.`,
        { executorType: executor.type },
      );
    }

    this.executors.set(executor.type, executor);
  }
}
