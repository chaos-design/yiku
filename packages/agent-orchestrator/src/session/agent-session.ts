import { createHash } from "node:crypto";
import {
  type HookDecision,
  HookError,
  type HookEventBase,
  type HookEventName,
  HookSession,
} from "@yiku/hooks";
import { type NotificationMessage, Notifier } from "../notifications/notifier.js";
import { PromptGuard, type PromptSegment, type PromptSegmentSource } from "../prompt/index.js";
import { TaskRegistry } from "../tasks/task-registry.js";
import { TodoAdapter } from "../tasks/todo-adapter.js";
import { WorkspaceConfigWatcher } from "../workspace/config-watcher.js";
import { WorkspaceFileWatcher } from "../workspace/file-watcher.js";
import { InstructionLoader } from "../workspace/instructions.js";
import { ContextCompactor } from "./compactor.js";
import { AgentStageStopError } from "./execution-policy.js";
import { SessionHistory, type SessionHistoryEntry } from "./history.js";
import { type AgentHookContext, resolveAgentHookContext } from "./hook-context.js";
import { MessageDisplay, type MessageDisplayResult } from "./message-display.js";
import { PromptExpansion } from "./prompt-expansion.js";
import { SetupRuntime } from "./setup.js";
import { SessionTranscript } from "./transcript.js";
import type {
  AgentSessionEndReason,
  AgentSessionOptions,
  AgentSessionStartSource,
  AgentSessionSubmitOptions,
} from "./types.js";

const HISTORY_MAX_CHARS = 32_768;

export type AgentSessionTurnRunner = (
  prompt: string,
  options: AgentSessionOptions,
) => Promise<string>;

export interface AgentSessionClassOptions extends AgentSessionOptions {
  readonly initialHistory?: readonly SessionHistoryEntry[] | undefined;
  readonly turnRunner?: AgentSessionTurnRunner | undefined;
}

export class AgentSession {
  private readonly context: AgentHookContext;
  private configWatcher?: WorkspaceConfigWatcher | undefined;
  private fileWatcher?: WorkspaceFileWatcher | undefined;
  private readonly history: SessionHistory;
  private readonly hookSession?: HookSession | undefined;
  private readonly options: AgentSessionClassOptions;
  private readonly promptGuard: PromptGuard;
  private readonly sessionAdditionalContext: PromptSegment[] = [];
  private readonly transcript: SessionTranscript;
  private readonly todoExecutor: AgentSessionOptions["todoExecutor"];
  private readonly turnRunner: AgentSessionTurnRunner;
  private closed = false;
  private started = false;

  public constructor(options: AgentSessionClassOptions = {}) {
    this.options = options;
    this.history = new SessionHistory(options.initialHistory);
    this.promptGuard = options.promptGuard ?? new PromptGuard();
    this.context = resolveAgentHookContext(options);
    this.transcript = new SessionTranscript({
      filePath: this.context.transcriptFilePath,
    });
    this.turnRunner = options.turnRunner ?? defaultTurnRunner;
    this.hookSession =
      options.hooks === undefined
        ? undefined
        : (options.hooks.hookSession ??
          new HookSession({
            engine: options.hooks.engine,
            environment: {
              ...process.env,
              ...options.env,
            },
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
          }));
    this.todoExecutor =
      options.todoExecutor ??
      (options.taskStore === undefined
        ? undefined
        : new TodoAdapter({
            registry: new TaskRegistry({
              eventBase: {
                ...this.baseEvent("TaskCreated"),
                hook_event_name: "TaskCreated",
              },
              ...(this.hookSession !== undefined ? { hookSession: this.hookSession } : {}),
              store: options.taskStore,
            }),
          }));
  }

  public async start(source: AgentSessionStartSource = "startup"): Promise<void> {
    this.assertOpen();
    if (this.started) {
      return;
    }

    this.started = true;
    const decision = await this.dispatch({
      ...this.baseEvent("SessionStart"),
      hook_event_name: "SessionStart",
      source,
    });
    this.configWatcher = this.createConfigWatcher();
    this.fileWatcher = this.createFileWatcher();
    this.requireAllowed("SessionStart", decision);
    this.appendSessionContext(decision.additionalContext, "hook", "SessionStart");
    await this.loadInstructions("session_start");
    await this.configWatcher?.start();
    await this.fileWatcher?.start();
  }

  public async submit(
    prompt: string,
    submitOptions: AgentSessionSubmitOptions = {},
  ): Promise<string> {
    this.assertOpen();
    await this.start();

    const normalizedPrompt = this.promptGuard.validateUserPrompt(prompt);

    const promptDecision = await this.dispatch({
      ...this.baseEvent("UserPromptSubmit"),
      hook_event_name: "UserPromptSubmit",
      prompt: normalizedPrompt,
    });
    this.requireAllowed("UserPromptSubmit", promptDecision);
    const expansion = await new PromptExpansion({
      eventBase: {
        ...this.baseEvent("UserPromptExpansion"),
        hook_event_name: "UserPromptExpansion",
      },
      ...(this.hookSession !== undefined ? { hookSession: this.hookSession } : {}),
    }).expand(submitOptions.commandName ?? "prompt", normalizedPrompt, submitOptions.commandArgs);
    await this.transcript.recordMessage("user", normalizedPrompt);

    let turnPrompt = this.promptGuard.validateUserPrompt(expansion.prompt);
    while (true) {
      try {
        const output = await this.turnRunner(
          turnPrompt,
          this.turnOptions(promptDecision, submitOptions, expansion.additionalContext),
        );
        const stopDecision = await this.dispatch({
          ...this.baseEvent("Stop"),
          hook_event_name: "Stop",
          last_assistant_message: output,
          stop_hook_active: false,
        });
        await this.transcript.recordMessage("assistant", output);

        if (stopDecision.action !== "block") {
          this.history.append("user", turnPrompt);
          this.history.append("assistant", output);
          return output;
        }

        this.history.append("user", turnPrompt);
        this.history.append("assistant", output);
        turnPrompt = this.promptGuard.validateUserPrompt(
          stopDecision.reasons.join("\n").trim() || "Continue working.",
        );
        this.history.append("system", turnPrompt);
      } catch (error) {
        if (error instanceof AgentStageStopError) {
          this.history.append("user", turnPrompt);
        } else {
          await this.recordStopFailure(error);
        }
        throw error;
      }
    }
  }

  public async clear(): Promise<void> {
    this.assertOpen();
    this.history.clear();
    const decision = await this.dispatch({
      ...this.baseEvent("SessionStart"),
      hook_event_name: "SessionStart",
      source: "clear",
    });
    this.requireAllowed("SessionStart", decision);
    this.appendSessionContext(decision.additionalContext, "hook", "SessionStart:clear");
    await this.loadInstructions("session_start");
  }

  public async compact(
    reason: "auto" | "manual",
    maxSummaryChars?: number,
    customInstructions?: string,
  ): Promise<void> {
    this.assertOpen();
    const summarizer = this.options.contextSummarizer ?? this.options.hooks?.summarizer;
    if (summarizer === undefined) {
      throw new Error("Context compaction requires a configured summarizer.");
    }
    const resolvedMaxSummaryChars = maxSummaryChars ?? this.options.hooks?.compactionMaxChars;

    await new ContextCompactor({
      eventBase: {
        ...this.baseEvent("PreCompact"),
        hook_event_name: "PreCompact",
      },
      history: this.history,
      ...(this.hookSession !== undefined ? { hookSession: this.hookSession } : {}),
      ...(resolvedMaxSummaryChars !== undefined
        ? { maxSummaryChars: resolvedMaxSummaryChars }
        : {}),
      ...(this.options.signal !== undefined ? { signal: this.options.signal } : {}),
      summarizer,
    }).compact(reason, customInstructions);
    const decision = await this.dispatch({
      ...this.baseEvent("SessionStart"),
      hook_event_name: "SessionStart",
      source: "compact",
    });
    this.requireAllowed("SessionStart", decision);
    this.appendSessionContext(decision.additionalContext, "hook", "SessionStart:compact");
    await this.loadInstructions("compact");
  }

  public async close(reason: AgentSessionEndReason = "other"): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    try {
      if (this.started) {
        await this.dispatch({
          ...this.baseEvent("SessionEnd"),
          hook_event_name: "SessionEnd",
          reason,
        });
      }
    } finally {
      this.configWatcher?.close();
      this.fileWatcher?.close();
      await this.hookSession?.close();
      await this.transcript.close();
    }
  }

  public sessionId(): string {
    return this.context.sessionId;
  }

  public historySnapshot(): readonly SessionHistoryEntry[] {
    return this.history.snapshot();
  }

  public restoreHistory(entries: readonly SessionHistoryEntry[]): void {
    this.assertOpen();
    this.history.restore(entries);
  }

  public transcriptFilePath(): string {
    return this.context.transcriptFilePath;
  }

  public present(message: string): Promise<MessageDisplayResult> {
    return new MessageDisplay({
      eventBase: {
        ...this.baseEvent("MessageDisplay"),
        hook_event_name: "MessageDisplay",
      },
      ...(this.hookSession !== undefined ? { hookSession: this.hookSession } : {}),
    }).present(message);
  }

  public async setup<T>(
    trigger: "init" | "maintenance",
    operation: () => Promise<T>,
  ): Promise<{ readonly decision?: HookDecision | undefined; readonly result: T }> {
    this.assertOpen();
    await this.start();
    return new SetupRuntime({
      eventBase: {
        ...this.baseEvent("Setup"),
        hook_event_name: "Setup",
      },
      ...(this.hookSession !== undefined ? { hookSession: this.hookSession } : {}),
    }).run(trigger, operation);
  }

  public async notify(
    notification: NotificationMessage,
    sink: (notification: NotificationMessage) => Promise<void> | void,
  ): Promise<void> {
    this.assertOpen();
    await this.start();
    await new Notifier({
      eventBase: {
        ...this.baseEvent("Notification"),
        hook_event_name: "Notification",
      },
      ...(this.hookSession !== undefined ? { hookSession: this.hookSession } : {}),
      sink,
    }).notify(notification);
  }

  private turnOptions(
    promptDecision: HookDecision,
    submitOptions: AgentSessionSubmitOptions,
    expansionContext: readonly string[] = [],
  ): AgentSessionOptions {
    const history = this.history.render(HISTORY_MAX_CHARS);
    const promptSegments = [
      ...(this.options.promptSegments ?? []),
      ...(history === undefined
        ? []
        : [referenceSegment(history, "runtime", "history", this.context.sessionId)]),
      ...this.sessionAdditionalContext,
      ...promptDecision.additionalContext.map((content) =>
        referenceSegment(content, "hook", "reference", "UserPromptSubmit"),
      ),
      ...expansionContext.map((content) =>
        referenceSegment(content, "hook", "reference", "UserPromptExpansion"),
      ),
      ...(this.hookSession?.drainBackgroundDecisions().additionalContext ?? []).map((content) =>
        referenceSegment(content, "hook", "reference", "background"),
      ),
    ];

    return {
      ...this.options,
      ...submitOptions,
      cwd: this.context.workspaceDir,
      ...(this.options.hooks !== undefined && this.hookSession !== undefined
        ? {
            hooks: {
              ...this.options.hooks,
              hookSession: this.hookSession,
            },
          }
        : {}),
      sessionId: this.context.sessionId,
      sessionsDir: this.context.sessionsDir,
      promptGuard: this.promptGuard,
      ...(promptSegments.length > 0 ? { promptSegments: Object.freeze(promptSegments) } : {}),
      ...(this.todoExecutor !== undefined ? { todoExecutor: this.todoExecutor } : {}),
    };
  }

  private async dispatch<TName extends HookEventName>(
    event: HookEventBase<TName> & Record<string, unknown>,
  ): Promise<HookDecision> {
    if (this.hookSession === undefined) {
      return emptyDecision();
    }

    const decision = await this.hookSession.dispatch(event as never);
    await this.transcript.recordHook(event.hook_event_name, decision);
    return decision;
  }

  private baseEvent<TName extends HookEventName>(hook_event_name: TName): HookEventBase<TName> {
    return {
      cwd: this.context.workspaceDir,
      hook_event_name,
      permission_mode: this.context.permissionMode,
      session_id: this.context.sessionId,
      transcript_path: this.context.transcriptFilePath,
    };
  }

  private requireAllowed(eventName: HookEventName, decision: HookDecision): void {
    if (decision.action !== "block" && decision.action !== "stop") {
      return;
    }

    throw new HookError(
      "HOOK_EXECUTION_FAILED",
      `${eventName} was blocked by Hook policy: ${decision.reasons.join("; ") || "blocked"}.`,
      { eventName },
    );
  }

  private appendSessionContext(
    values: readonly string[],
    source: PromptSegmentSource,
    sourceId: string,
    digest?: string,
  ): void {
    for (const value of values) {
      const segment = referenceSegment(value, source, "reference", sourceId, digest);
      if (
        !this.sessionAdditionalContext.some(
          (current) =>
            current.content === segment.content &&
            current.source === segment.source &&
            current.sourceId === segment.sourceId,
        )
      ) {
        this.sessionAdditionalContext.push(segment);
      }
    }
  }

  private createConfigWatcher(): WorkspaceConfigWatcher | undefined {
    const hooks = this.options.hooks;
    if (hooks?.configFiles === undefined || hooks.configFiles.length === 0) {
      return undefined;
    }

    return new WorkspaceConfigWatcher({
      files: hooks.configFiles,
      onChange: async (change) => {
        const decision = await this.dispatch({
          ...this.baseEvent("ConfigChange"),
          file_path: change.path,
          hook_event_name: "ConfigChange",
          source: change.source,
        });
        if (decision.action === "block" || decision.action === "stop") {
          return;
        }
        await hooks.applyConfig?.(change);
      },
      ...(hooks.onWatcherError !== undefined ? { onError: hooks.onWatcherError } : {}),
    });
  }

  private createFileWatcher(): WorkspaceFileWatcher | undefined {
    const hooks = this.options.hooks;
    if (hooks?.watchedFiles === undefined || hooks.watchedFiles.length === 0) {
      return undefined;
    }

    return new WorkspaceFileWatcher({
      onChange: async (change) => {
        await this.dispatch({
          ...this.baseEvent("FileChanged"),
          file_path: change.path,
          hook_event_name: "FileChanged",
        });
      },
      ...(hooks.onWatcherError !== undefined ? { onError: hooks.onWatcherError } : {}),
      paths: hooks.watchedFiles,
    });
  }

  private async loadInstructions(reason: "compact" | "session_start"): Promise<void> {
    const paths = this.options.hooks?.instructionFiles;
    if (paths === undefined || paths.length === 0) {
      return;
    }

    const documents = await new InstructionLoader({
      workspaceDir: this.context.workspaceDir,
    }).load(paths, reason);

    for (const document of documents) {
      const decision = await this.dispatch({
        ...this.baseEvent("InstructionsLoaded"),
        file_path: document.path,
        hook_event_name: "InstructionsLoaded",
        load_reason: document.loadReason,
      });
      this.appendSessionContext(
        [document.content],
        "workspace",
        document.path,
        createHash("sha256").update(document.content).digest("hex"),
      );
      this.appendSessionContext(
        decision.additionalContext,
        "hook",
        `InstructionsLoaded:${document.path}`,
      );
    }
  }

  private async recordStopFailure(error: unknown): Promise<void> {
    try {
      await this.dispatch({
        ...this.baseEvent("StopFailure"),
        error: error instanceof Error ? error.message : String(error),
        error_type: "unknown",
        hook_event_name: "StopFailure",
      });
    } catch (hookError) {
      await this.transcript.recordMessage(
        "system",
        `StopFailure Hook failed: ${hookError instanceof Error ? hookError.message : String(hookError)}`,
      );
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("Agent Session is closed.");
    }
  }
}

function referenceSegment(
  content: string,
  source: PromptSegmentSource,
  kind: Extract<PromptSegment["kind"], "history" | "reference">,
  sourceId: string,
  digest?: string,
): PromptSegment {
  return Object.freeze({
    content,
    ...(digest !== undefined ? { digest } : {}),
    kind,
    source,
    sourceId,
    trust: "untrusted",
  });
}

async function defaultTurnRunner(prompt: string, options: AgentSessionOptions): Promise<string> {
  const { runAgentSessionTurn } = await import("./session.js");
  return runAgentSessionTurn(prompt, options);
}

function emptyDecision(): HookDecision {
  return {
    action: "no-op",
    additionalContext: [],
    diagnostics: [],
    permissionUpdates: [],
    reasons: [],
    suppressOutput: false,
    systemMessages: [],
  };
}
