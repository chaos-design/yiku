import type { HookEventBase, HookSession } from "@yiku/hooks";
import { requireText } from "../validation.js";

export interface TeamWorkerState {
  readonly activeTaskId?: string | undefined;
  readonly idle: boolean;
  readonly name: string;
}

export interface TeamRuntimeOptions {
  readonly eventBase: HookEventBase<"TeammateIdle">;
  readonly hookSession?: HookSession | undefined;
  readonly teamName: string;
}

export class TeamRuntime {
  private readonly workers = new Map<string, TeamWorkerState>();

  public constructor(private readonly options: TeamRuntimeOptions) {}

  public register(name: string): TeamWorkerState {
    const normalized = requireText(name, "Worker name");
    if (this.workers.has(normalized)) {
      throw new Error(`Worker already exists: ${normalized}.`);
    }

    const worker = Object.freeze({ idle: true, name: normalized });
    this.workers.set(normalized, worker);
    return worker;
  }

  public assign(workerName: string, taskId: string): TeamWorkerState {
    const current = this.requireWorker(workerName);
    const worker = Object.freeze({
      activeTaskId: requireText(taskId, "Task ID"),
      idle: false,
      name: current.name,
    });
    this.workers.set(current.name, worker);
    return worker;
  }

  public async markIdle(workerName: string): Promise<boolean> {
    const current = this.requireWorker(workerName);
    const decision = await this.options.hookSession?.dispatch({
      ...this.options.eventBase,
      hook_event_name: "TeammateIdle",
      team_name: this.options.teamName,
      teammate_name: current.name,
    });

    if (decision?.action === "block" || decision?.action === "stop") {
      return false;
    }

    this.workers.set(
      current.name,
      Object.freeze({
        idle: true,
        name: current.name,
      }),
    );
    return true;
  }

  public get(workerName: string): TeamWorkerState | undefined {
    return this.workers.get(workerName);
  }

  public list(): readonly TeamWorkerState[] {
    return Object.freeze([...this.workers.values()]);
  }

  private requireWorker(name: string): TeamWorkerState {
    const worker = this.workers.get(name);
    if (worker === undefined) {
      throw new Error(`Worker not found: ${name}.`);
    }
    return worker;
  }
}
