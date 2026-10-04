import { randomUUID } from "node:crypto";
import type { SkillSnapshot } from "./skill-types.js";

export interface SkillWorkerRunInput {
  readonly prompt: string;
  readonly signal?: AbortSignal | undefined;
  readonly snapshot: SkillSnapshot;
  readonly workerId: string;
}

export interface SkillWorkerResult {
  readonly output: string;
  readonly skillName: string;
  readonly status: "succeeded";
  readonly workerId: string;
}

export interface SkillWorkerOptions {
  readonly idGenerator?: (() => string) | undefined;
  readonly maxParallelWorkers?: number | undefined;
  readonly onEvent?:
    | ((
        event:
          | {
              readonly name: string;
              readonly type: "skill_worker_started";
              readonly workerId: string;
            }
          | {
              readonly name: string;
              readonly status: "failed" | "succeeded";
              readonly type: "skill_worker_finished";
              readonly workerId: string;
            },
      ) => void)
    | undefined;
  readonly run: (input: SkillWorkerRunInput) => Promise<string>;
}

interface WaitingWorker {
  readonly reject: (error: unknown) => void;
  readonly resolve: () => void;
  readonly signal?: AbortSignal | undefined;
  readonly onAbort?: (() => void) | undefined;
}

export class SkillWorker {
  private active = 0;
  private readonly idGenerator: () => string;
  private readonly maximum: number;
  private readonly queue: WaitingWorker[] = [];

  public constructor(private readonly options: SkillWorkerOptions) {
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.maximum = options.maxParallelWorkers ?? 3;
    if (!Number.isSafeInteger(this.maximum) || this.maximum <= 0) {
      throw new Error("Skill Worker concurrency must be a positive integer.");
    }
  }

  public async run(
    snapshot: SkillSnapshot,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<SkillWorkerResult> {
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) {
      throw new Error("Skill Worker prompt must be non-empty.");
    }
    await this.acquire(signal);
    const workerId = this.idGenerator();
    this.options.onEvent?.({
      name: snapshot.name,
      type: "skill_worker_started",
      workerId,
    });

    try {
      const output = await this.options.run({
        prompt: normalizedPrompt,
        ...(signal !== undefined ? { signal } : {}),
        snapshot,
        workerId,
      });
      this.options.onEvent?.({
        name: snapshot.name,
        status: "succeeded",
        type: "skill_worker_finished",
        workerId,
      });
      return Object.freeze({
        output,
        skillName: snapshot.name,
        status: "succeeded",
        workerId,
      });
    } catch (error) {
      this.options.onEvent?.({
        name: snapshot.name,
        status: "failed",
        type: "skill_worker_finished",
        workerId,
      });
      throw error;
    } finally {
      this.release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(abortReason(signal));
    }
    if (this.active < this.maximum) {
      this.active += 1;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiting: WaitingWorker = {
        reject,
        resolve,
        ...(signal !== undefined ? { signal } : {}),
        ...(signal !== undefined
          ? {
              onAbort: () => {
                const index = this.queue.indexOf(waiting);
                if (index >= 0) {
                  this.queue.splice(index, 1);
                }
                reject(abortReason(signal));
              },
            }
          : {}),
      };
      signal?.addEventListener("abort", waiting.onAbort as () => void, { once: true });
      this.queue.push(waiting);
    });
  }

  private release(): void {
    this.active -= 1;
    const waiting = this.queue.shift();
    if (waiting === undefined) {
      return;
    }
    waiting.signal?.removeEventListener("abort", waiting.onAbort as () => void);
    this.active += 1;
    waiting.resolve();
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error ? signal.reason : new Error("Skill Worker was cancelled.");
}
