import { randomUUID } from "node:crypto";
import type { ToolEffect, ToolExecutionMiddleware, ToolExecutionRequest } from "@yiku/agent-code";
import type { SessionState } from "../session/session-state.js";
import { WorkspaceSnapshotLimitError } from "../workspace/workspace-snapshot-store.js";

const SUMMARY_MAX_CHARACTERS = 8_192;

export interface SessionToolCheckpointStore {
  load(sessionId: string): Promise<SessionState>;
  update(
    sessionId: string,
    expectedRevision: number,
    update: (current: SessionState) => SessionState,
  ): Promise<SessionState>;
  updateCurrent?(
    sessionId: string,
    update: (current: SessionState) => SessionState,
  ): Promise<SessionState>;
}

export interface SessionToolWorkspaceCheckpointService {
  beforeTool(): Promise<unknown>;
}

export interface SessionToolCheckpointRequest {
  readonly callId: string;
  readonly effect: ToolEffect;
  readonly input: unknown;
  readonly signal?: AbortSignal | undefined;
  readonly toolName: string;
}

export type SessionToolShouldCheckpoint = (request: SessionToolCheckpointRequest) => boolean;

export type SessionToolCheckpointApproval = (
  request: SessionToolCheckpointRequest,
) => boolean | Promise<boolean>;

export interface SessionToolMiddlewareOptions {
  readonly checkpointApproval?: SessionToolCheckpointApproval | undefined;
  readonly checkpointService?: SessionToolWorkspaceCheckpointService | undefined;
  readonly inner?: ToolExecutionMiddleware | undefined;
  readonly now?: (() => Date) | undefined;
  readonly sessionId: string;
  readonly shouldCheckpoint?: SessionToolShouldCheckpoint | undefined;
  readonly stageId: () => string;
  readonly store: SessionToolCheckpointStore;
}

export class SessionToolCheckpointApprovalError extends Error {
  public override readonly name = "SessionToolCheckpointApprovalError";

  public constructor(
    public readonly request: SessionToolCheckpointRequest,
    public readonly limitError: WorkspaceSnapshotLimitError,
  ) {
    super(
      `Tool ${request.toolName} requires approval to run without a workspace checkpoint after ` +
        `the snapshot ${limitError.kind} limit was exceeded.`,
      { cause: limitError },
    );
  }
}

export class SessionToolMiddleware implements ToolExecutionMiddleware {
  private readonly inner?: ToolExecutionMiddleware | undefined;
  private readonly now: () => Date;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(private readonly options: SessionToolMiddlewareOptions) {
    this.inner = options.inner;
    this.now = options.now ?? (() => new Date());
  }

  public async run<TInput, TOutput>(
    request: ToolExecutionRequest<TInput, TOutput>,
  ): Promise<TOutput> {
    const callId = request.callId ?? randomUUID();
    const effect = request.effect ?? "external";
    const startedAt = this.now().toISOString();
    const resolvedRequest = {
      ...request,
      callId,
      effect,
    };

    await this.mutate((state) => {
      if (state.inFlightOperations.some((operation) => operation.callId === callId)) {
        throw new Error(`Tool call is already in flight: ${callId}.`);
      }
      return {
        ...state,
        budget: {
          ...state.budget,
          toolCalls: state.budget.toolCalls + 1,
        },
        inFlightOperations: [
          ...state.inFlightOperations,
          {
            callId,
            effect,
            inputSummary: summarize(request.input),
            stageId: this.options.stageId(),
            startedAt,
            toolName: request.toolName,
          },
        ],
      };
    });

    try {
      await this.checkpointBeforeTool(resolvedRequest);
      const output =
        this.inner === undefined
          ? await request.execute(request.input)
          : await this.inner.run(resolvedRequest);
      await this.complete(resolvedRequest, effect, "succeeded", output);
      return output;
    } catch (error) {
      try {
        await this.complete(resolvedRequest, effect, "failed", error);
      } catch (checkpointError) {
        throw new AggregateError(
          [error, checkpointError],
          `Tool ${request.toolName} failed and its completion checkpoint could not be saved.`,
        );
      }
      throw error;
    }
  }

  private async checkpointBeforeTool(request: SessionToolCheckpointRequest): Promise<void> {
    const checkpointService = this.options.checkpointService;
    if (
      checkpointService === undefined ||
      (request.effect !== "write" &&
        (request.effect !== "process" || this.options.shouldCheckpoint?.(request) !== true))
    ) {
      return;
    }

    try {
      await checkpointService.beforeTool();
    } catch (error) {
      if (!(error instanceof WorkspaceSnapshotLimitError)) {
        throw error;
      }
      const approved = await this.options.checkpointApproval?.(request);
      if (approved !== true) {
        throw new SessionToolCheckpointApprovalError(request, error);
      }
    }
  }

  private complete<TInput, TOutput>(
    request: ToolExecutionRequest<TInput, TOutput> & {
      readonly callId: string;
    },
    effect: ToolEffect,
    status: "failed" | "succeeded",
    output: unknown,
  ): Promise<SessionState> {
    return this.mutate((state) => ({
      ...state,
      budget: {
        ...state.budget,
        progressRevision:
          status === "succeeded" && effect !== "read"
            ? state.budget.progressRevision + 1
            : state.budget.progressRevision,
      },
      inFlightOperations: state.inFlightOperations.filter(
        (operation) => operation.callId !== request.callId,
      ),
      lastCompletedOperation: {
        callId: request.callId,
        completedAt: this.now().toISOString(),
        effect,
        inputSummary: summarize(request.input),
        outputSummary: summarize(output),
        stageId: this.options.stageId(),
        status,
        toolName: request.toolName,
      },
    }));
  }

  private mutate(update: (state: SessionState) => SessionState): Promise<SessionState> {
    const operation = async () => {
      return updateCurrentSessionState(this.options.store, this.options.sessionId, update);
    };
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
}

export async function updateCurrentSessionState(
  store: SessionToolCheckpointStore,
  sessionId: string,
  update: (current: SessionState) => SessionState,
): Promise<SessionState> {
  if (store.updateCurrent !== undefined) {
    return store.updateCurrent(sessionId, update);
  }
  const current = await store.load(sessionId);
  return store.update(sessionId, current.revision, update);
}

function summarize(value: unknown): string {
  let text: string;
  if (value instanceof Error) {
    text = value.message;
  } else if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }

  const normalized = text.trim();
  const suffix = "\n[truncated]";
  return normalized.length <= SUMMARY_MAX_CHARACTERS
    ? normalized
    : `${normalized.slice(0, SUMMARY_MAX_CHARACTERS - suffix.length)}${suffix}`;
}
