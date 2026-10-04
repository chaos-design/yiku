import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { tool } from "@openai/agents";
import {
  executeTool,
  formatToolError,
  type ToolCallMetadata,
  type ToolExecutionMiddleware,
} from "@yiku/agent-code";
import type { HookEventBase, HookSession } from "@yiku/hooks";
import { z } from "zod";
import { SubagentRuntime } from "../agents/subagent-runtime.js";
import type { AgentMessageBus } from "../messages/message-bus.js";
import type { AgentProgressHandler } from "../runtime/types.js";
import type { TaskRegistry } from "../tasks/task-registry.js";
import { TeamRuntime } from "../tasks/team-runtime.js";
import { WorkspaceWriteLock } from "../tasks/write-lock.js";
import type {
  CreateWorktreeInput,
  RemoveWorktreeOptions,
  WorktreeChangeSet,
  WorktreeHandle,
} from "../workspace/worktree-manager.js";

const delegateTaskInputSchema = z
  .object({
    access_mode: z.enum(["read-only", "read-write"]).default("read-only"),
    agent_key: z.string().trim().min(1),
    isolation: z.enum(["shared", "worktree"]).optional(),
    prompt: z.string().trim().min(1),
    task_id: z.string().trim().min(1).optional(),
  })
  .strict();

export type DelegateAccessMode = "read-only" | "read-write";
export type DelegateIsolation = "shared" | "worktree";
export type DelegateTaskInput = z.infer<typeof delegateTaskInputSchema>;

export interface VerificationSummary {
  readonly checks: readonly {
    readonly key: string;
    readonly passed: boolean;
    readonly summary: string;
  }[];
  readonly passed: boolean;
}

export interface DelegateAgentRunResult {
  readonly changedFiles?: readonly string[] | undefined;
  readonly output: string;
  readonly patch?: string | undefined;
  readonly verification?: VerificationSummary | undefined;
  readonly worktreeId?: string | undefined;
}

export interface DelegateAgentRunInput {
  readonly accessMode: DelegateAccessMode;
  readonly agentId: string;
  readonly agentKey: string;
  readonly isolation: DelegateIsolation;
  readonly parentToolCallId?: string | undefined;
  readonly prompt: string;
  readonly signal?: AbortSignal | undefined;
  readonly taskId: string;
  readonly workspaceDir: string;
}

export interface DelegateTaskResult {
  readonly changedFiles: readonly string[];
  readonly output: string;
  readonly patch?: string | undefined;
  readonly taskId: string;
  readonly verification?: VerificationSummary | undefined;
  readonly worktreeId?: string | undefined;
}

export interface DelegateTaskToolOptions {
  readonly allowedAgentKeys: readonly string[];
  readonly eventBase: HookEventBase<"SubagentStart">;
  readonly hookSession?: HookSession | undefined;
  readonly idGenerator?: (() => string) | undefined;
  readonly maxParallelReaders?: number | undefined;
  readonly messageBus?: AgentMessageBus | undefined;
  readonly middleware?: ToolExecutionMiddleware | undefined;
  readonly name?: string | undefined;
  readonly onEvent?: AgentProgressHandler | undefined;
  readonly parentAgentId?: string | undefined;
  readonly resolveAgent?:
    | ((agentKey: string) => {
        readonly agentName: string;
        readonly agentType: string;
      })
    | undefined;
  readonly run: (input: DelegateAgentRunInput) => Promise<DelegateAgentRunResult>;
  readonly taskRegistry: TaskRegistry;
  readonly transcriptPath?: ((agentId: string) => string) | undefined;
  readonly worktreeManager?: DelegateWorktreeManager | undefined;
  readonly writeLock?: WorkspaceWriteLock | undefined;
}

export interface DelegateWorktreeManager {
  collectChanges(handle: WorktreeHandle, signal?: AbortSignal): Promise<WorktreeChangeSet>;
  create(input: CreateWorktreeInput): Promise<WorktreeHandle>;
  remove(handle: WorktreeHandle, options?: RemoveWorktreeOptions): Promise<void>;
}

interface DelegateInvocation {
  readonly parentToolCallId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export function delegateTaskTool(options: DelegateTaskToolOptions) {
  const name = options.name ?? "delegateTaskTool";
  const runtime = new DelegateToolRuntime(options);

  return tool({
    description:
      "Delegate one bounded task to an allowed Agent. Write tasks use Worktree isolation when available and return output, changed files, patch, verification, and task metadata.",
    errorFunction: (_context: unknown, error: unknown) => formatToolError(error),
    execute: (input: DelegateTaskInput, _context?: unknown, details?: ToolCallMetadata) =>
      executeTool(
        {
          ...(details?.toolCall?.callId !== undefined ? { callId: details.toolCall.callId } : {}),
          effect: input.access_mode === "read-only" ? "read" : "write",
          execute: (resolved) =>
            runtime.run(resolved, {
              ...(details?.toolCall?.callId !== undefined
                ? { parentToolCallId: details.toolCall.callId }
                : {}),
              ...(details?.signal !== undefined ? { signal: details.signal } : {}),
            }),
          input,
          ...(details?.signal !== undefined ? { signal: details.signal } : {}),
          toolName: name,
          validate: (value) => delegateTaskInputSchema.parse(value),
        },
        options.middleware,
      ),
    name,
    parameters: delegateTaskInputSchema,
    strict: true,
  });
}

class DelegateToolRuntime {
  private readonly allowedAgentKeys: ReadonlySet<string>;
  private readonly idGenerator: () => string;
  private readonly readers: ConcurrencyLimiter;
  private readonly subagents: SubagentRuntime;
  private readonly team: TeamRuntime;
  private readonly writeLock: WorkspaceWriteLock;

  public constructor(private readonly options: DelegateTaskToolOptions) {
    this.allowedAgentKeys = new Set(options.allowedAgentKeys);
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.readers = new ConcurrencyLimiter(options.maxParallelReaders ?? 3);
    this.subagents = new SubagentRuntime({
      eventBase: options.eventBase,
      ...(options.hookSession !== undefined ? { hookSession: options.hookSession } : {}),
      ...(options.messageBus !== undefined ? { messageBus: options.messageBus } : {}),
    });
    this.team = new TeamRuntime({
      eventBase: {
        ...options.eventBase,
        hook_event_name: "TeammateIdle",
      },
      ...(options.hookSession !== undefined ? { hookSession: options.hookSession } : {}),
      teamName: `session-${options.eventBase.session_id}`,
    });
    this.writeLock = options.writeLock ?? new WorkspaceWriteLock();
  }

  public async run(
    input: DelegateTaskInput,
    invocation: DelegateInvocation = {},
  ): Promise<DelegateTaskResult> {
    const { parentToolCallId, signal } = invocation;
    if (!this.allowedAgentKeys.has(input.agent_key)) {
      throw new Error(`Delegate Agent is not allowed: ${input.agent_key}.`);
    }
    const task =
      input.task_id === undefined
        ? await this.options.taskRegistry.create({
            owner: input.agent_key,
            subject: input.prompt,
          })
        : await this.requireTask(input.task_id);
    const agentId = this.idGenerator();
    const agentIdentity = this.options.resolveAgent?.(input.agent_key) ?? {
      agentName: input.agent_key,
      agentType: input.agent_key,
    };
    const agentSessionId = `${this.options.eventBase.session_id}.agent.${agentId}`;
    const parentAgentId = this.options.parentAgentId ?? "root";
    let isolation: Awaited<ReturnType<DelegateToolRuntime["resolveIsolation"]>>;
    try {
      isolation = await this.resolveIsolation(input, task.id, signal);
    } catch (error) {
      await this.blockTask(task.id);
      throw error;
    }
    this.options.onEvent?.({
      agentId,
      agentKey: input.agent_key,
      agentName: agentIdentity.agentName,
      agentSessionId,
      agentType: agentIdentity.agentType,
      parentAgentId,
      parentSessionId: this.options.eventBase.session_id,
      ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
      profileId: input.agent_key,
      prompt: input.prompt,
      taskId: task.id,
      type: "subagent_spawned",
    });
    this.team.register(agentId);
    this.team.assign(agentId, task.id);

    let runResult: DelegateAgentRunResult | undefined;
    const subagentContext = {
      agentId,
      agentKey: input.agent_key,
      agentName: agentIdentity.agentName,
      agentSessionId,
      agentType: agentIdentity.agentType,
      parentAgentId,
      parentSessionId: this.options.eventBase.session_id,
      ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
      profileId: input.agent_key,
      prompt: input.prompt,
      taskId: task.id,
    };
    const execute = () =>
      this.subagents.run({
        ...subagentContext,
        agentTranscriptPath:
          this.options.transcriptPath?.(agentId) ??
          defaultTranscriptPath(this.options.eventBase.transcript_path, agentId),
        run: async (feedback) => {
          runResult = await this.options.run({
            accessMode: input.access_mode,
            agentId,
            agentKey: input.agent_key,
            isolation: isolation.kind,
            ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
            prompt: feedback ? `${input.prompt}\n\n${feedback}` : input.prompt,
            ...(signal !== undefined ? { signal } : {}),
            taskId: task.id,
            workspaceDir: isolation.handle?.path ?? this.options.eventBase.cwd,
          });
          return runResult.output;
        },
      });

    let taskCompleted = false;
    try {
      await (input.access_mode === "read-only"
        ? this.readers.run(execute)
        : isolation.kind === "worktree"
          ? execute()
          : this.writeLock.runExclusive(execute));
      if (runResult === undefined) {
        throw new Error("Delegate Agent completed without a result.");
      }
      if (isolation.handle !== undefined && this.options.worktreeManager !== undefined) {
        const changes = await this.options.worktreeManager.collectChanges(isolation.handle, signal);
        runResult = {
          ...runResult,
          changedFiles: changes.changedFiles,
          patch: changes.patch,
          worktreeId: isolation.handle.id,
        };
        await this.removeCompletedWorktree(isolation.handle, signal);
      }
      if (input.access_mode === "read-only" && (runResult.changedFiles?.length ?? 0) > 0) {
        throw new Error("Read-only Delegate reported workspace changes.");
      }
      const current = await this.requireTask(task.id);
      await this.options.taskRegistry.complete({
        expectedRevision: current.revision,
        id: current.id,
        teammateName: input.agent_key,
      });
      taskCompleted = true;
      this.options.onEvent?.({
        agentId,
        agentName: agentIdentity.agentName,
        agentSessionId,
        output: runResult.output,
        profileId: input.agent_key,
        taskId: task.id,
        type: "subagent_output",
      });
      await this.subagents.finish(subagentContext, "succeeded");
      this.options.onEvent?.({
        agentId,
        agentName: agentIdentity.agentName,
        agentSessionId,
        profileId: input.agent_key,
        status: "succeeded",
        taskId: task.id,
        type: "subagent_result",
      });
    } catch (error) {
      if (!taskCompleted) {
        await this.blockTask(task.id);
      }
      await this.team.markIdle(agentId).catch(() => undefined);
      if (!taskCompleted) {
        const status = signal?.aborted ? "cancelled" : "failed";
        const errorMessage = error instanceof Error ? error.message : String(error);
        await this.subagents.finish(subagentContext, status, errorMessage);
        this.options.onEvent?.({
          agentId,
          agentName: agentIdentity.agentName,
          agentSessionId,
          error: errorMessage,
          profileId: input.agent_key,
          status,
          taskId: task.id,
          type: "subagent_result",
        });
      }
      throw error;
    }

    await this.team.markIdle(agentId);
    return Object.freeze({
      changedFiles: Object.freeze([...(runResult?.changedFiles ?? [])]),
      output: runResult?.output ?? "",
      ...(runResult?.patch !== undefined ? { patch: runResult.patch } : {}),
      taskId: task.id,
      ...(runResult?.verification !== undefined ? { verification: runResult.verification } : {}),
      ...(runResult?.worktreeId !== undefined ? { worktreeId: runResult.worktreeId } : {}),
    });
  }

  private async requireTask(taskId: string) {
    const task = await this.options.taskRegistry.get(taskId);
    if (task === undefined) {
      throw new Error(`Task not found: ${taskId}.`);
    }
    return task;
  }

  private async removeCompletedWorktree(
    handle: WorktreeHandle,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.options.worktreeManager?.remove(handle, {
        force: true,
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error.code === "WORKTREE_HOOK_BLOCKED" || error.code === "WORKTREE_HOOK_DEFERRED")
      ) {
        return;
      }
      throw error;
    }
  }

  private async blockTask(taskId: string): Promise<void> {
    const current = await this.options.taskRegistry.get(taskId);
    if (current !== undefined && current.status !== "blocked") {
      await this.options.taskRegistry.block({
        expectedRevision: current.revision,
        id: current.id,
      });
    }
  }

  private async resolveIsolation(
    input: DelegateTaskInput,
    taskId: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly handle?: WorktreeHandle | undefined;
    readonly kind: DelegateIsolation;
  }> {
    if (input.access_mode === "read-only") {
      if (input.isolation === "worktree") {
        throw new Error("Read-only Delegates cannot request Worktree isolation.");
      }
      return { kind: "shared" };
    }
    if (input.isolation === "shared") {
      return { kind: "shared" };
    }
    const manager = this.options.worktreeManager;
    if (manager === undefined) {
      if (input.isolation === "worktree") {
        throw new Error("Worktree isolation is not configured.");
      }
      return { kind: "shared" };
    }
    try {
      return {
        handle: await manager.create({
          name: `${input.agent_key}-${taskId}`,
          ...(signal !== undefined ? { signal } : {}),
          taskId,
        }),
        kind: "worktree",
      };
    } catch (error) {
      if (
        input.isolation === undefined &&
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "GIT_WORKTREE_UNAVAILABLE"
      ) {
        return { kind: "shared" };
      }
      throw error;
    }
  }
}

class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  public constructor(private readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum <= 0) {
      throw new Error("Reader concurrency must be a positive integer.");
    }
  }

  public async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maximum) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    this.queue.shift()?.();
  }
}

function defaultTranscriptPath(rootTranscriptPath: string, agentId: string): string {
  return join(dirname(rootTranscriptPath), "agents", `${agentId}.transcript.jsonl`);
}
