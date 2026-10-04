import { randomUUID } from "node:crypto";
import {
  type AgentMessageEnvelope,
  type AgentProgressEvent,
  progressEventToEnvelope,
  type SessionState,
  type SessionSubagentProfile,
} from "@yiku/agent-orchestrator";
import { type EnvVars, loadEnvFile, mergeEnv } from "@yiku/config";
import { Box, useApp, useInput, usePaste, useStdout, useWindowSize } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AgentSessionContext,
  CliAgentSession,
  type CliAgentSessionContract,
  type CliModelSummary,
  type CliSkillCommand,
  type executeAgentSession,
} from "./agent-session.js";
import { CommandOverlayView } from "./app/command-overlay.js";
import {
  applyFileCompletion,
  getFileCompletionQuery,
  getShellCommandQuery,
} from "./app/completion.js";
import { DEFAULT_WORKSPACE_LABEL, SLASH_COMMAND_MENU_MAX_VISIBLE_ROWS } from "./app/constants.js";
import { type FileEntry, type ReadDirectory, searchWorkspaceEntries } from "./app/file-search.js";
import {
  calculateContextUsage,
  formatContextUsageDetails,
  formatDuration,
  formatTokenCount,
  SessionMetrics,
} from "./app/session-metrics.js";
import { buildShellResultView } from "./app/shell-output.js";
import { getElapsedSeconds } from "./app/time.js";
import { createRuntimeTimelineState, reduceRuntimeTimeline } from "./app/timeline-reducer.js";
import { formatRuntimeEvent, formatToolCall, formatToolResult } from "./app/tool-presentation.js";
import type {
  ActiveCommand,
  AgentMessageSource,
  MessageContent,
  MessageRole,
  RuntimeTimelineState,
  SessionMessage,
  SessionStatus,
  TimelineHeaderItem,
  TimelineItem,
  TimelineToolItem,
} from "./app/types.js";
import {
  isQuestionTextInput,
  UserInteractionController,
  type UserInteractionState,
  type WorkspaceAccessMode,
} from "./app/user-interaction.js";
import { UserInteractionView } from "./app/user-interaction-view.js";
import { FileCompletionMenu, SlashCommandMenu, StatusBar, Timeline } from "./app/views.js";
import {
  clampCursorIndex,
  hasLineBreak,
  insertTextAt,
  isLineContinuation,
  moveCursorByWord,
  moveCursorToLineBoundary,
  moveCursorVertically,
  normalizeLineBreaks,
  PROMPT_LAYOUT_RESERVED_ROWS,
  PROMPT_MIN_VISIBLE_COLUMNS,
  PROMPT_MIN_VISIBLE_ROWS,
  PromptInput,
  type QueuedPrompt,
  QueuedPromptList,
} from "./prompts/index.js";
import {
  ClipboardService,
  type ShellCommandResult,
  type ShellCommandRunOptions,
  ShellCommandService,
} from "./services/index.js";
import { CliSessionController } from "./session-controller.js";
import {
  applySlashCommandCompletion,
  createSlashCommands,
  getSlashCommandQuery,
  getSlashCommandSuggestions,
  resolveSlashCommand,
  SLASH_COMMANDS,
} from "./slash-commands/index.js";
import type {
  CommandOverlay,
  SlashCommandClipboard,
  SlashCommandContext,
  SlashCommandResult,
  SlashCommandSubmitResult,
} from "./slash-commands/types.js";

type RunPrompt = typeof executeAgentSession;
type ActiveMenu = "file" | "none" | "slash";
const CLEAR_TERMINAL_SEQUENCE = "\u001B[2J\u001B[H";
const SETUP_INTERACTION_RUN_ID = 0;
const SUBAGENT_RENDER_INTERVAL_MS = 100;

export interface ShellCommandRunner {
  run(command: string, options?: ShellCommandRunOptions): Promise<ShellCommandResult>;
}

type PromptSubmission = SlashCommandSubmitResult;

interface SubmitPromptOptions {
  readonly fromQueue?: boolean | undefined;
  readonly remember?: boolean | undefined;
}

export { YIKU_LOGO } from "./app/constants.js";
export { PROMPT_CURSOR } from "./prompts/index.js";

export interface AppProps {
  readonly accessMode?: WorkspaceAccessMode | undefined;
  readonly agentEnvironment?: EnvVars | undefined;
  readonly agentSession?: CliAgentSessionContract | undefined;
  readonly agentKey?: string | undefined;
  readonly autoExit?: boolean;
  readonly clipboard?: SlashCommandClipboard | undefined;
  readonly continueSession?: boolean | undefined;
  readonly initOnly?: boolean | undefined;
  readonly migrateLegacy?: boolean | undefined;
  readonly messageEvents?: AgentMessageSource | undefined;
  readonly onExitCode?: (code: number) => void;
  readonly prompt: string;
  readonly persistWorkspaceWriteAccess?: (() => Promise<void>) | undefined;
  readonly readDirectory?: ReadDirectory;
  readonly resumeSessionId?: string | undefined;
  readonly runPromptImpl?: RunPrompt | undefined;
  readonly sessionId?: string | undefined;
  readonly setupMode?: "init" | "maintenance" | undefined;
  readonly shellCommandRunner?: ShellCommandRunner | undefined;
  readonly staticTranscript?: boolean | undefined;
  readonly userInteractionController?: UserInteractionController | undefined;
  readonly userInteractionState?: UserInteractionState | undefined;
  readonly workspaceDir?: string;
}

export function App({
  accessMode = "read-write",
  agentEnvironment,
  agentSession: providedAgentSession,
  agentKey,
  autoExit = false,
  clipboard: providedClipboard,
  continueSession = false,
  initOnly = false,
  migrateLegacy = false,
  messageEvents,
  onExitCode = setProcessExitCode,
  prompt,
  persistWorkspaceWriteAccess,
  readDirectory,
  resumeSessionId,
  runPromptImpl,
  sessionId,
  setupMode,
  shellCommandRunner: providedShellCommandRunner,
  staticTranscript,
  userInteractionController: providedUserInteractionController,
  userInteractionState: providedUserInteractionState,
  workspaceDir = DEFAULT_WORKSPACE_LABEL,
}: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const terminalSize = useWindowSize();
  const [clipboard] = useState<SlashCommandClipboard>(
    () => providedClipboard ?? new ClipboardService(),
  );
  const [shellCommandRunner] = useState<ShellCommandRunner>(
    () =>
      providedShellCommandRunner ??
      new ShellCommandService({
        cwd: workspaceDir,
        ...(agentEnvironment !== undefined ? { env: { ...process.env, ...agentEnvironment } } : {}),
      }),
  );
  const [modelFallback] = useState(() => resolveModelFallback(workspaceDir, agentEnvironment));
  const [effectiveAccessMode, setEffectiveAccessMode] = useState<WorkspaceAccessMode>(accessMode);
  const [resolvedSessionId] = useState(() => sessionId?.trim() || randomUUID());
  const [rootAgentId] = useState(() => agentKey?.trim() || "root");
  const [sessionInputEnabled, setSessionInputEnabled] = useState(true);
  const [agentSession] = useState<CliAgentSessionContract>(() => {
    if (providedAgentSession !== undefined) {
      return providedAgentSession;
    }

    const createSession = (
      targetSessionId?: string,
      activationOptions: { readonly resumeStartsEpoch?: boolean | undefined } = {},
    ) =>
      new CliAgentSession({
        accessMode,
        ...(agentKey !== undefined ? { agentKey } : {}),
        ...(continueSession ? { continueSession: true } : {}),
        ...(migrateLegacy ? { migrateLegacy: true } : {}),
        ...(runPromptImpl === undefined
          ? { cwd: workspaceDir }
          : { runAgentSessionImpl: runPromptImpl }),
        ...(agentEnvironment !== undefined ? { env: agentEnvironment } : {}),
        ...(targetSessionId !== undefined ? { resumeSessionId: targetSessionId } : {}),
        ...(activationOptions.resumeStartsEpoch !== undefined
          ? { resumeStartsEpoch: activationOptions.resumeStartsEpoch }
          : {}),
        sessionId: resolvedSessionId,
      });

    return new CliSessionController({
      createSession,
      initialSession: createSession(resumeSessionId),
      onInputEnabled: setSessionInputEnabled,
    });
  });
  const [sessionStartedAtMs] = useState(Date.now);
  const useStaticTranscript = staticTranscript ?? Boolean(stdout.isTTY);
  const hasModelPresentationResolver =
    agentSession.currentModel !== undefined || agentSession.models !== undefined;
  const [staticTranscriptReady, setStaticTranscriptReady] = useState(
    () => !useStaticTranscript || !hasModelPresentationResolver,
  );
  const [timelineGeneration, setTimelineGeneration] = useState(0);
  const [committedItems, setCommittedItems] = useState<readonly TimelineItem[]>(() => [
    createHeaderItem(0, modelFallback, workspaceDir),
  ]);
  const [commandOverlay, setCommandOverlay] = useState<CommandOverlay | undefined>();
  const [activeCommand, setActiveCommand] = useState<ActiveCommand | undefined>();
  const [activeAssistant, setActiveAssistant] = useState<SessionMessage | undefined>();
  const [activeTool, setActiveTool] = useState<TimelineToolItem | undefined>();
  const [cursorIndex, setCursorIndex] = useState(0);
  const [fileEntries, setFileEntries] = useState<readonly FileEntry[]>([]);
  const [input, setInput] = useState("");
  const [menuSelectedIndex, setMenuSelectedIndex] = useState(0);
  const [manualExitPending, setManualExitPending] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());
  const [outputStyle, setOutputStyle] = useState<SessionState["outputStyle"]>("default");
  const [queuedPrompts, setQueuedPrompts] = useState<readonly QueuedPrompt[]>([]);
  const [setupReady, setSetupReady] = useState(setupMode === undefined);
  const [slashCommands, setSlashCommands] = useState(SLASH_COMMANDS);
  const [spinnerIndex, setSpinnerIndex] = useState(0);
  const [status, setStatus] = useState<SessionStatus>({ kind: "idle" });
  const [statusBarMessage, setStatusBarMessage] = useState<string | undefined>();
  const [promptStatus, setPromptStatus] = useState<{
    readonly contextTokens: number;
    readonly contextWindow?: number | undefined;
    readonly model: string;
  }>({
    contextTokens: 0,
    model: modelFallback,
  });
  const [runtimeTimeline, setRuntimeTimeline] = useState<RuntimeTimelineState>(() =>
    createRuntimeTimelineState(rootAgentId),
  );
  const [localUserInteractionState, setLocalUserInteractionState] = useState<
    UserInteractionState | undefined
  >();
  const [localUserInteractionController] = useState(
    () =>
      new UserInteractionController({
        onStateChange: setLocalUserInteractionState,
      }),
  );
  const userInteractionController =
    providedUserInteractionController ?? localUserInteractionController;
  const userInteractionState =
    providedUserInteractionController === undefined
      ? localUserInteractionState
      : providedUserInteractionState;
  const activeAbortControllerRef = useRef<AbortController | undefined>(undefined);
  const archivedAgentIdsRef = useRef(new Set<string>());
  const activeRunIdRef = useRef<number | undefined>(undefined);
  const activeAssistantRef = useRef<SessionMessage | undefined>(undefined);
  const activeToolRef = useRef<TimelineToolItem | undefined>(undefined);
  const commandExecutionIdRef = useRef(0);
  const commandHistoryRef = useRef<readonly string[]>([]);
  const commandOverlayContinuationRef = useRef<(() => void) | undefined>(undefined);
  const committedItemsRef = useRef<readonly TimelineItem[]>(committedItems);
  const cursorIndexRef = useRef(0);
  const fileEntriesRef = useRef<readonly FileEntry[]>([]);
  const fileSearchIdRef = useRef(0);
  const historyDraftRef = useRef("");
  const historyIndexRef = useRef<number | undefined>(undefined);
  const historyModeRef = useRef<"command" | "shell">("command");
  const shellHistoryRef = useRef<readonly string[]>([]);
  const initialPromptSubmittedRef = useRef(false);
  const inputRef = useRef("");
  const menuSelectedIndexRef = useRef(0);
  const messageIdRef = useRef(0);
  const manualExitRequestedRef = useRef(false);
  const metricsRef = useRef<SessionMetrics | undefined>(undefined);
  const preferredCursorColumnRef = useRef<number | undefined>(undefined);
  const queuedPromptIdRef = useRef(0);
  const queuedPromptsRef = useRef<readonly QueuedPrompt[]>([]);
  const runIdRef = useRef(0);
  const runtimeTimelineRef = useRef(runtimeTimeline);
  const setupStartedRef = useRef(false);
  const agentCommandsRef = useRef<readonly SessionSubagentProfile[]>([]);
  const skillCommandsRef = useRef<readonly CliSkillCommand[]>([]);
  const slashCommandsRef = useRef(SLASH_COMMANDS);
  const statusBarMessageTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const subagentRenderTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const submitPromptRef = useRef<(rawPrompt: string, options?: SubmitPromptOptions) => void>(
    () => undefined,
  );
  const lastCtrlCAtRef = useRef(0);

  if (metricsRef.current === undefined) {
    metricsRef.current = new SessionMetrics({
      model: modelFallback,
      sessionId: resolvedSessionId,
      startedAtMs: sessionStartedAtMs,
    });
  }

  const syncPromptStatus = useCallback(() => {
    const snapshot = metricsRef.current?.snapshot();
    if (snapshot === undefined) {
      return;
    }
    setPromptStatus({
      contextTokens: snapshot.contextTokens,
      ...(snapshot.contextWindow === undefined ? {} : { contextWindow: snapshot.contextWindow }),
      model: snapshot.model,
    });
  }, []);

  const setFileEntriesState = useCallback((entries: readonly FileEntry[]) => {
    fileEntriesRef.current = entries;
    setFileEntries(entries);
  }, []);

  const setMenuSelectedIndexState = useCallback((nextIndex: number) => {
    menuSelectedIndexRef.current = nextIndex;
    setMenuSelectedIndex(nextIndex);
  }, []);

  const replaceSlashCommandCatalog = useCallback(
    (skills: readonly CliSkillCommand[], agents: readonly SessionSubagentProfile[]) => {
      const commands = createSlashCommands(skills, agents);
      skillCommandsRef.current = skills;
      agentCommandsRef.current = agents;
      slashCommandsRef.current = commands;
      setSlashCommands(commands);
      setMenuSelectedIndexState(0);
    },
    [setMenuSelectedIndexState],
  );

  const computeMenuState = useCallback(() => {
    const currentInput = inputRef.current;
    const currentCursorIndex = cursorIndexRef.current;

    if (getSlashCommandQuery(currentInput, currentCursorIndex)) {
      setFileEntriesState([]);
      setMenuSelectedIndexState(0);
      return;
    }

    const completion = getFileCompletionQuery(currentInput, currentCursorIndex);

    if (!completion) {
      fileSearchIdRef.current += 1;
      setFileEntriesState([]);
      setMenuSelectedIndexState(0);
      return;
    }

    const searchId = fileSearchIdRef.current + 1;
    fileSearchIdRef.current = searchId;

    searchWorkspaceEntries({
      cwd: workspaceDir,
      query: completion.query,
      ...(readDirectory ? { readDirectory } : {}),
    })
      .then((entries) => {
        if (fileSearchIdRef.current !== searchId) {
          return;
        }

        setFileEntriesState(entries);
        setMenuSelectedIndexState(0);
      })
      .catch(() => {
        if (fileSearchIdRef.current !== searchId) {
          return;
        }

        setFileEntriesState([]);
        setMenuSelectedIndexState(0);
      });
  }, [readDirectory, setFileEntriesState, setMenuSelectedIndexState, workspaceDir]);

  const getActiveMenu = useCallback((): { length: number; menu: ActiveMenu } => {
    const currentInput = inputRef.current;
    const currentCursorIndex = cursorIndexRef.current;

    if (getSlashCommandQuery(currentInput, currentCursorIndex)) {
      return {
        length: getSlashCommandSuggestions(
          currentInput,
          currentCursorIndex,
          slashCommandsRef.current,
        ).length,
        menu: "slash",
      };
    }

    if (
      getFileCompletionQuery(currentInput, currentCursorIndex) &&
      fileEntriesRef.current.length > 0
    ) {
      return { length: fileEntriesRef.current.length, menu: "file" };
    }

    return { length: 0, menu: "none" };
  }, []);

  const updateInput = useCallback(
    (
      nextInput: string | ((currentInput: string) => string),
      options: {
        readonly cursorIndex?: number;
        readonly preserveHistoryNavigation?: boolean;
      } = {},
    ) => {
      const resolvedInput =
        typeof nextInput === "function" ? nextInput(inputRef.current) : nextInput;
      const resolvedCursorIndex = clampCursorIndex(
        options.cursorIndex ?? resolvedInput.length,
        resolvedInput,
      );

      inputRef.current = resolvedInput;
      cursorIndexRef.current = resolvedCursorIndex;
      preferredCursorColumnRef.current = undefined;
      setInput(resolvedInput);
      setCursorIndex(resolvedCursorIndex);

      if (!options.preserveHistoryNavigation) {
        historyDraftRef.current = "";
        historyIndexRef.current = undefined;
      }

      computeMenuState();
    },
    [computeMenuState],
  );

  const appendCommittedItems = useCallback((items: readonly TimelineItem[]) => {
    const nextItems = [...committedItemsRef.current, ...items];
    committedItemsRef.current = nextItems;
    setCommittedItems(nextItems);
  }, []);

  const updateHeaderModel = useCallback((model: string) => {
    setPromptStatus((current) =>
      current.model === model
        ? current
        : {
            ...current,
            model,
          },
    );
    const currentHeader = committedItemsRef.current.find(
      (item): item is TimelineHeaderItem => item.kind === "header",
    );
    if (currentHeader === undefined || currentHeader.model === model) {
      return;
    }
    const nextItems = committedItemsRef.current.map((item) =>
      item.kind === "header" ? { ...item, model } : item,
    );
    committedItemsRef.current = nextItems;
    setCommittedItems(nextItems);
  }, []);

  const refreshModelPresentation = useCallback(async () => {
    try {
      const [modelKey, models] = await Promise.all([
        agentSession.currentModel?.() ?? Promise.resolve(undefined),
        agentSession.models?.() ?? Promise.resolve<readonly CliModelSummary[]>([]),
      ]);
      const selectedModel = models.find((model) => model.key === modelKey);
      const resolvedModel = selectedModel?.model ?? modelKey?.trim();
      if (!resolvedModel) {
        return;
      }
      updateHeaderModel(resolvedModel);
      const snapshot = metricsRef.current?.snapshot();
      if (snapshot !== undefined) {
        const modelChanged = snapshot.model !== resolvedModel;
        metricsRef.current?.updateContext(
          resolvedModel,
          selectedModel?.contextWindow ?? (modelChanged ? undefined : snapshot.contextWindow),
          snapshot.contextComposition,
          snapshot.compactAtContextRatio,
          selectedModel?.contextWindowSource ??
            (modelChanged ? undefined : snapshot.contextWindowSource),
        );
        if (modelChanged) {
          metricsRef.current?.resetContext();
        }
        syncPromptStatus();
      }
    } finally {
      setStaticTranscriptReady(true);
    }
  }, [agentSession, syncPromptStatus, updateHeaderModel]);

  const createMessage = useCallback(
    (
      role: MessageRole,
      text: string,
      presentation: Pick<
        SessionMessage,
        "contextUsage" | "lineColors" | "lineIndents" | "title" | "tone"
      > = {},
    ) => {
      const id = messageIdRef.current + 1;
      messageIdRef.current = id;

      return {
        id,
        role,
        text,
        ...presentation,
      } satisfies SessionMessage;
    },
    [],
  );

  const commitMessage = useCallback(
    (
      role: MessageRole,
      text: string,
      presentation: Pick<
        SessionMessage,
        "contextUsage" | "lineColors" | "lineIndents" | "title" | "tone"
      > = {},
    ) => {
      const message = createMessage(role, text, presentation);
      appendCommittedItems([
        {
          id: `message:${message.id}`,
          kind: "message",
          message,
        },
      ]);

      return message;
    },
    [appendCommittedItems, createMessage],
  );

  const setActiveAssistantState = useCallback((message: SessionMessage | undefined) => {
    activeAssistantRef.current = message;
    setActiveAssistant(message);
  }, []);

  const setActiveToolState = useCallback((tool: TimelineToolItem | undefined) => {
    activeToolRef.current = tool;
    setActiveTool(tool);
  }, []);

  const handleAgentMessage = useCallback(
    (message: AgentMessageEnvelope) => {
      const current = runtimeTimelineRef.current;
      if (!isSubagentMessage(current, message)) {
        return;
      }
      if (message.payload.kind === "agent_spawned") {
        if (current.agents.has(message.agentId)) {
          return;
        }
        archivedAgentIdsRef.current.delete(message.agentId);
      } else if (archivedAgentIdsRef.current.has(message.agentId)) {
        return;
      }

      let next = attachAgentMessageMetadata(reduceRuntimeTimeline(current, message), message);
      const agent = next.agents.get(message.agentId);
      if (agent !== undefined && agent.status !== "running") {
        appendCommittedItems([
          {
            agent,
            id: `agent:${agent.agentId}:${agent.completedAt ?? message.eventId}`,
            kind: "agent",
          },
        ]);
        archivedAgentIdsRef.current.add(agent.agentId);
        const agents = new Map(next.agents);
        agents.delete(agent.agentId);
        next = {
          ...next,
          agents,
        };
      }
      runtimeTimelineRef.current = next;
      if (message.payload.kind === "assistant_delta") {
        subagentRenderTimerRef.current ??= setTimeout(() => {
          subagentRenderTimerRef.current = undefined;
          setRuntimeTimeline(runtimeTimelineRef.current);
        }, SUBAGENT_RENDER_INTERVAL_MS);
        return;
      }
      if (subagentRenderTimerRef.current !== undefined) {
        clearTimeout(subagentRenderTimerRef.current);
        subagentRenderTimerRef.current = undefined;
      }
      setRuntimeTimeline(next);
    },
    [appendCommittedItems],
  );

  const commitActiveAssistant = useCallback((): boolean => {
    const message = activeAssistantRef.current;

    if (message === undefined || !message.text.trim()) {
      setActiveAssistantState(undefined);
      return false;
    }

    appendCommittedItems([
      {
        id: `message:${message.id}`,
        kind: "message",
        message,
      },
    ]);
    setActiveAssistantState(undefined);

    return true;
  }, [appendCommittedItems, setActiveAssistantState]);

  const commitActiveTool = useCallback(
    (result?: MessageContent | undefined, output?: unknown): boolean => {
      const tool = activeToolRef.current;

      if (tool === undefined) {
        return false;
      }

      appendCommittedItems([
        {
          ...tool,
          ...(output !== undefined ? { output } : {}),
          ...(result !== undefined ? { result } : {}),
        },
      ]);
      setActiveToolState(undefined);

      return true;
    },
    [appendCommittedItems, setActiveToolState],
  );

  const updateQueuedPrompts = useCallback(
    (
      nextQueuedPrompts:
        | readonly QueuedPrompt[]
        | ((currentQueuedPrompts: readonly QueuedPrompt[]) => readonly QueuedPrompt[]),
    ) => {
      const resolvedQueuedPrompts =
        typeof nextQueuedPrompts === "function"
          ? nextQueuedPrompts(queuedPromptsRef.current)
          : nextQueuedPrompts;

      queuedPromptsRef.current = resolvedQueuedPrompts;
      setQueuedPrompts(resolvedQueuedPrompts);
    },
    [],
  );

  const clearQueuedPrompts = useCallback(() => {
    updateQueuedPrompts([]);
  }, [updateQueuedPrompts]);

  const enqueuePrompt = useCallback(
    (text: string) => {
      const id = queuedPromptIdRef.current + 1;
      queuedPromptIdRef.current = id;
      updateQueuedPrompts((currentQueuedPrompts) => [...currentQueuedPrompts, { id, text }]);
    },
    [updateQueuedPrompts],
  );

  const shiftQueuedPrompt = useCallback((): string | undefined => {
    const [nextPrompt, ...remainingPrompts] = queuedPromptsRef.current;

    updateQueuedPrompts(remainingPrompts);

    return nextPrompt?.text;
  }, [updateQueuedPrompts]);

  const restoreQueuedPrompt = useCallback((): boolean => {
    const queuedPrompt = queuedPromptsRef.current.at(-1);

    if (!queuedPrompt) {
      return false;
    }

    updateQueuedPrompts((currentQueuedPrompts) => currentQueuedPrompts.slice(0, -1));
    updateInput(queuedPrompt.text, { cursorIndex: queuedPrompt.text.length });

    return true;
  }, [updateInput, updateQueuedPrompts]);

  const cancelActiveRun = useCallback(
    (reason = "User canceled the active task.") => {
      const activeRunId = activeRunIdRef.current;

      if (activeRunId === undefined) {
        return;
      }

      userInteractionController.cancelRun(activeRunId, reason);
      const finishedAtMs = Date.now();
      metricsRef.current?.finishRun(activeRunId, finishedAtMs);
      metricsRef.current?.finishActiveTool(finishedAtMs);
      activeAbortControllerRef.current?.abort(new Error(reason));
      activeAbortControllerRef.current = undefined;
      activeRunIdRef.current = undefined;
      commitActiveAssistant();
      commitActiveTool();
      setStatus({ kind: "idle" });
      commitMessage("system", "Canceled current task.");
    },
    [commitActiveAssistant, commitActiveTool, commitMessage, userInteractionController],
  );

  const runNextQueuedPrompt = useCallback(() => {
    const nextPrompt = shiftQueuedPrompt();

    if (nextPrompt) {
      setTimeout(
        () => submitPromptRef.current(nextPrompt, { fromQueue: true, remember: false }),
        0,
      );
    }

    return Boolean(nextPrompt);
  }, [shiftQueuedPrompt]);

  const setCursorPosition = useCallback(
    (nextCursorIndex: number, preferredColumn?: number) => {
      const resolvedCursorIndex = clampCursorIndex(nextCursorIndex, inputRef.current);

      cursorIndexRef.current = resolvedCursorIndex;
      preferredCursorColumnRef.current = preferredColumn;
      setCursorIndex(resolvedCursorIndex);
      computeMenuState();
    },
    [computeMenuState],
  );

  const moveCursor = useCallback(
    (offset: number) => {
      setCursorPosition(cursorIndexRef.current + offset);
    },
    [setCursorPosition],
  );

  const moveCursorVertical = useCallback(
    (direction: "down" | "up") => {
      const movement = moveCursorVertically(
        inputRef.current,
        cursorIndexRef.current,
        direction,
        preferredCursorColumnRef.current,
      );

      setCursorPosition(movement.cursorIndex, movement.preferredColumn);
    },
    [setCursorPosition],
  );

  const moveMenuSelection = useCallback(
    (offset: number): boolean => {
      const { length } = getActiveMenu();

      if (length === 0) {
        return false;
      }

      const nextIndex = (menuSelectedIndexRef.current + offset + length) % length;
      setMenuSelectedIndexState(nextIndex);

      return true;
    },
    [getActiveMenu, setMenuSelectedIndexState],
  );

  const applySelectedMenuEntry = useCallback((): boolean => {
    const { length, menu } = getActiveMenu();

    if (menu === "none" || length === 0) {
      return false;
    }

    const selectedIndex = Math.min(menuSelectedIndexRef.current, length - 1);

    if (menu === "slash") {
      const currentInput = inputRef.current;
      const currentCursorIndex = cursorIndexRef.current;
      const command = getSlashCommandSuggestions(
        currentInput,
        currentCursorIndex,
        slashCommandsRef.current,
      )[selectedIndex];
      const completion = getSlashCommandQuery(currentInput, currentCursorIndex);

      if (!command || !completion) {
        return false;
      }

      const applied = applySlashCommandCompletion(currentInput, completion, command.name);
      updateInput(applied.value, { cursorIndex: applied.cursorIndex });

      return true;
    }

    const entry = fileEntriesRef.current[selectedIndex];
    const completion = getFileCompletionQuery(inputRef.current, cursorIndexRef.current);

    if (!entry || !completion) {
      return false;
    }

    const applied = applyFileCompletion(inputRef.current, completion, entry.insertValue);
    updateInput(applied.value, { cursorIndex: applied.cursorIndex });

    return true;
  }, [getActiveMenu, updateInput]);

  const rememberCommand = useCallback((command: string) => {
    const isShellCommand = getShellCommandQuery(command) !== undefined;
    const historyRef = isShellCommand ? shellHistoryRef : commandHistoryRef;

    if (historyRef.current.at(-1) !== command) {
      historyRef.current = [...historyRef.current, command];
    }

    historyDraftRef.current = "";
    historyIndexRef.current = undefined;
  }, []);

  const restoreHistory = useCallback(
    (direction: "down" | "up") => {
      if (historyIndexRef.current === undefined) {
        historyModeRef.current =
          getShellCommandQuery(inputRef.current) !== undefined ? "shell" : "command";
      }
      const history =
        historyModeRef.current === "shell" ? shellHistoryRef.current : commandHistoryRef.current;

      if (history.length === 0) {
        return;
      }

      if (direction === "up") {
        const nextHistoryIndex =
          historyIndexRef.current === undefined
            ? history.length - 1
            : Math.max(0, historyIndexRef.current - 1);

        if (historyIndexRef.current === undefined) {
          historyDraftRef.current = inputRef.current;
        }

        historyIndexRef.current = nextHistoryIndex;
        updateInput(history[nextHistoryIndex] ?? "", {
          cursorIndex: history[nextHistoryIndex]?.length ?? 0,
          preserveHistoryNavigation: true,
        });
        return;
      }

      if (historyIndexRef.current === undefined) {
        return;
      }

      if (historyIndexRef.current < history.length - 1) {
        const nextHistoryIndex = historyIndexRef.current + 1;
        historyIndexRef.current = nextHistoryIndex;
        updateInput(history[nextHistoryIndex] ?? "", {
          cursorIndex: history[nextHistoryIndex]?.length ?? 0,
          preserveHistoryNavigation: true,
        });
        return;
      }

      const draft = historyDraftRef.current;
      historyDraftRef.current = "";
      historyIndexRef.current = undefined;
      updateInput(draft, {
        cursorIndex: draft.length,
        preserveHistoryNavigation: true,
      });
    },
    [updateInput],
  );

  const startAgentRun = useCallback(
    (submittedPrompt: string, promptSubmission?: PromptSubmission) => {
      const abortController = new AbortController();
      const runId = runIdRef.current + 1;
      const startedAtMs = Date.now();
      const displayPrompt = promptSubmission?.displayPrompt ?? submittedPrompt;
      let lastAssistantText = "";
      let segmentText = "";
      let streamedText = "";
      runIdRef.current = runId;
      activeAbortControllerRef.current = abortController;
      activeRunIdRef.current = runId;
      metricsRef.current?.startRun(runId, startedAtMs);
      setActiveAssistantState(undefined);
      setActiveToolState(undefined);
      updateInput("", { cursorIndex: 0 });
      setStatus({
        kind: "processing",
        prompt: displayPrompt,
        responseBytes: 0,
        startedAtMs,
      });
      commitMessage("user", displayPrompt);

      agentSession
        .submit(submittedPrompt, {
          ...(promptSubmission !== undefined
            ? {
                activatedSkills: promptSubmission.activatedSkills,
                ...(promptSubmission.commandArgs !== undefined
                  ? { commandArgs: promptSubmission.commandArgs }
                  : {}),
                commandName: promptSubmission.commandName,
              }
            : {}),
          hookTrustApprovalHandler: (request) => {
            setFileEntriesState([]);
            setMenuSelectedIndexState(0);
            return userInteractionController.requestHookTrust(runId, request);
          },
          mcpElicitationHandler: (request) => {
            setFileEntriesState([]);
            setMenuSelectedIndexState(0);
            return userInteractionController.requestMcpElicitation(runId, request);
          },
          onHookStatusMessage: setStatusBarMessage,
          onMessage: handleAgentMessage,
          permissionApprovalHandler: (request) => {
            setFileEntriesState([]);
            setMenuSelectedIndexState(0);
            return userInteractionController.requestPermission(runId, {
              ...request,
              metadata: {
                ...request.metadata,
                requirement: displayPrompt,
              },
            });
          },
          workspaceAccessApprovalHandler: async (request) => {
            setFileEntriesState([]);
            setMenuSelectedIndexState(0);
            const response = await userInteractionController.requestWorkspaceWriteAccess(
              runId,
              request,
            );
            if (response.decision !== "allow") {
              return response;
            }
            if (response.persistence === "persistent") {
              try {
                await persistWorkspaceWriteAccess?.();
              } catch (error) {
                return {
                  decision: "deny",
                  reason: `Unable to persist Workspace write access: ${getErrorMessage(error)}`,
                };
              }
            }
            setEffectiveAccessMode("read-write");
            return response;
          },
          resumeReviewHandler: (request) => {
            setFileEntriesState([]);
            setMenuSelectedIndexState(0);
            return userInteractionController.requestResumeReview(runId, request);
          },
          signal: abortController.signal,
          onContext: (context: AgentSessionContext) => {
            updateHeaderModel(context.model);
            const currentHeader = committedItemsRef.current.find(
              (item): item is TimelineHeaderItem => item.kind === "header",
            );
            if (
              currentHeader !== undefined &&
              currentHeader.workspaceDir !== context.workspaceDir
            ) {
              const nextItems = committedItemsRef.current.map((item) =>
                item.kind === "header"
                  ? {
                      ...item,
                      workspaceDir: context.workspaceDir,
                    }
                  : item,
              );
              committedItemsRef.current = nextItems;
              setCommittedItems(nextItems);
            }
            metricsRef.current?.updateContext(
              context.model,
              context.contextWindow,
              context.contextComposition,
              context.compactAtContextRatio,
              context.contextWindowSource,
            );
            syncPromptStatus();
          },
          onEvent: (event: AgentProgressEvent) => {
            if (activeRunIdRef.current !== runId) {
              return;
            }
            metricsRef.current?.recordRuntimeEvent(event);
            if (event.type === "context_compacted") {
              syncPromptStatus();
            }
            if (event.type === "usage_updated") {
              metricsRef.current?.recordUsage(runId, event.model, event.usage);
              syncPromptStatus();
              return;
            }

            if (event.type === "checkpoint_saved") {
              setStatusBarMessage(`Checkpoint r${event.checkpointRevision} · ${event.stageId}`);
              return;
            }

            if (
              event.type === "subagent_spawned" ||
              event.type === "subagent_output" ||
              event.type === "subagent_result"
            ) {
              handleAgentMessage(
                progressEventToEnvelope(event, {
                  agentId: rootAgentId,
                  sessionId: resolvedSessionId,
                }),
              );
            }

            const runtimeContent = formatRuntimeEvent(event);
            if (runtimeContent !== undefined) {
              commitActiveAssistant();
              commitActiveTool();
              const id = messageIdRef.current + 1;
              messageIdRef.current = id;
              appendCommittedItems([
                {
                  content: runtimeContent,
                  id: `runtime:${id}`,
                  kind: "runtime",
                },
              ]);
              return;
            }

            switch (event.type) {
              case "agent_updated":
                commitMessage("system", `Agent: ${event.agentName}`);
                return;
              case "handoff":
                commitMessage(
                  "system",
                  event.sourceAgentName
                    ? `Handoff: ${event.sourceAgentName} -> ${event.targetAgentName}`
                    : `Handoff: ${event.targetAgentName}`,
                );
                return;
              case "message_delta":
                streamedText += event.text;
                segmentText += event.text;
                setStatus((currentStatus) =>
                  currentStatus.kind === "processing"
                    ? {
                        ...currentStatus,
                        responseBytes:
                          currentStatus.responseBytes + Buffer.byteLength(event.text, "utf8"),
                      }
                    : currentStatus,
                );

                if (!segmentText.trim()) {
                  return;
                }

                if (activeAssistantRef.current === undefined) {
                  setActiveAssistantState(createMessage("assistant", segmentText));
                  return;
                }

                setActiveAssistantState({
                  ...activeAssistantRef.current,
                  text: segmentText,
                });
                return;
              case "reasoning":
                return;
              case "tool_called": {
                metricsRef.current?.recordToolCall(event, Date.now());
                if (activeAssistantRef.current?.text.trim()) {
                  lastAssistantText = activeAssistantRef.current.text;
                }
                commitActiveAssistant();
                commitActiveTool();
                segmentText = "";
                const id = messageIdRef.current + 1;
                messageIdRef.current = id;
                setActiveToolState({
                  call: formatToolCall(event),
                  ...(event.callId !== undefined ? { callId: event.callId } : {}),
                  id: `tool:${id}`,
                  ...(event.input !== undefined ? { input: event.input } : {}),
                  kind: "tool",
                  toolName: event.toolName,
                });
                return;
              }
              case "tool_output": {
                metricsRef.current?.recordToolOutput(event, Date.now());
                const currentTool = activeToolRef.current;

                const matchesCurrentTool =
                  currentTool !== undefined &&
                  (event.callId !== undefined
                    ? currentTool.callId === event.callId
                    : currentTool.toolName === event.toolName);

                if (!matchesCurrentTool) {
                  commitActiveTool();
                  const id = messageIdRef.current + 1;
                  messageIdRef.current = id;
                  appendCommittedItems([
                    {
                      call: {
                        text: event.title,
                      },
                      ...(event.callId !== undefined ? { callId: event.callId } : {}),
                      id: `tool:${id}`,
                      kind: "tool",
                      ...(event.output !== undefined ? { output: event.output } : {}),
                      result: formatToolResult(event, undefined),
                      toolName: event.toolName,
                    },
                  ]);
                  return;
                }

                commitActiveTool(formatToolResult(event, currentTool.input), event.output);
                return;
              }
              case "user_question_requested":
                setFileEntriesState([]);
                setMenuSelectedIndexState(0);
                void userInteractionController.askUser(runId, event.request).then(
                  (response) => {
                    if (activeRunIdRef.current !== runId) {
                      return;
                    }
                    try {
                      agentSession.answerUserQuestion(event.questionId, response);
                    } catch (error) {
                      setStatusBarMessage(`User question failed: ${getErrorMessage(error)}`);
                    }
                  },
                  (error: unknown) => {
                    if (activeRunIdRef.current !== runId) {
                      return;
                    }
                    activeAbortControllerRef.current?.abort(error);
                    try {
                      agentSession.cancelUserQuestion(event.questionId, getErrorMessage(error));
                    } catch (cancelError) {
                      setStatusBarMessage(
                        `User question cancellation failed: ${getErrorMessage(cancelError)}`,
                      );
                    } finally {
                      cancelActiveRun();
                    }
                  },
                );
                return;
              case "user_question_cancelled":
              case "user_question_resolved":
                return;
            }
          },
        })
        .then((output) => {
          metricsRef.current?.finishRun(runId, Date.now());

          if (activeRunIdRef.current !== runId) {
            return;
          }

          activeAbortControllerRef.current = undefined;
          activeRunIdRef.current = undefined;
          if (activeAssistantRef.current?.text.trim()) {
            lastAssistantText = activeAssistantRef.current.text;
          }
          commitActiveAssistant();
          commitActiveTool();
          setStatus({ kind: "idle" });

          const normalizedOutput = output.trim();
          const normalizedStream = streamedText.trim();
          if (
            normalizedOutput &&
            normalizedOutput !== normalizedStream &&
            normalizedOutput !== lastAssistantText.trim()
          ) {
            commitMessage("assistant", output);
          } else if (!normalizedOutput && !normalizedStream) {
            commitMessage("assistant", "(empty output)");
          }

          appendCommittedItems([
            {
              durationSeconds: getElapsedSeconds(startedAtMs),
              id: `summary:${runId}`,
              kind: "summary",
            },
          ]);
          onExitCode(0);

          if (runNextQueuedPrompt()) {
            return;
          }

          if (autoExit) {
            void agentSession.close("prompt_input_exit").finally(() => exit());
          }
        })
        .catch((error: unknown) => {
          metricsRef.current?.finishRun(runId, Date.now());
          metricsRef.current?.finishActiveTool(Date.now());

          if (activeRunIdRef.current !== runId) {
            return;
          }

          const message = getErrorMessage(error);
          const source = getErrorSource(error);
          activeAbortControllerRef.current = undefined;
          activeRunIdRef.current = undefined;
          commitActiveAssistant();
          commitActiveTool();
          setStatus({ kind: "error", message, ...(source !== undefined ? { source } : {}) });
          onExitCode(1);

          if (runNextQueuedPrompt()) {
            return;
          }

          if (autoExit) {
            void agentSession.close("prompt_input_exit").finally(() => exit());
          }
        });
    },
    [
      agentSession,
      appendCommittedItems,
      autoExit,
      cancelActiveRun,
      commitActiveAssistant,
      commitActiveTool,
      commitMessage,
      createMessage,
      exit,
      handleAgentMessage,
      onExitCode,
      persistWorkspaceWriteAccess,
      resolvedSessionId,
      rootAgentId,
      runNextQueuedPrompt,
      setActiveAssistantState,
      setActiveToolState,
      setFileEntriesState,
      setMenuSelectedIndexState,
      syncPromptStatus,
      updateHeaderModel,
      updateInput,
      userInteractionController,
    ],
  );
  const startShellRun = useCallback(
    (command: string) => {
      const trimmedCommand = command.trim();
      if (!trimmedCommand) {
        return;
      }

      const abortController = new AbortController();
      const runId = runIdRef.current + 1;
      const startedAtMs = Date.now();
      runIdRef.current = runId;
      activeAbortControllerRef.current = abortController;
      activeRunIdRef.current = runId;
      metricsRef.current?.startRun(runId, startedAtMs);
      updateInput("", { cursorIndex: 0 });
      setStatus({
        kind: "processing",
        prompt: `!${trimmedCommand}`,
        responseBytes: 0,
        startedAtMs,
      });
      commitMessage("user", `!${trimmedCommand}`);

      shellCommandRunner
        .run(trimmedCommand, { signal: abortController.signal })
        .then((result) => {
          metricsRef.current?.finishRun(runId, Date.now());
          if (activeRunIdRef.current !== runId) {
            return;
          }
          activeAbortControllerRef.current = undefined;
          activeRunIdRef.current = undefined;
          const view = buildShellResultView(result);
          commitMessage("command", view.text, {
            lineColors: view.lineColors,
            title: `Shell${result.exitCode === 0 ? "" : ` (exit ${result.exitCode ?? "killed"})`}`,
            tone: result.exitCode === 0 ? "default" : "error",
          });
          appendCommittedItems([
            {
              durationSeconds: getElapsedSeconds(startedAtMs),
              id: `summary:${runId}`,
              kind: "summary",
            },
          ]);
          setStatus({ kind: "idle" });
          onExitCode(result.exitCode === 0 ? 0 : 1);
          if (runNextQueuedPrompt()) {
            return;
          }
          if (autoExit) {
            void agentSession.close("prompt_input_exit").finally(() => exit());
          }
        })
        .catch((error: unknown) => {
          metricsRef.current?.finishRun(runId, Date.now());
          if (activeRunIdRef.current !== runId) {
            return;
          }
          activeAbortControllerRef.current = undefined;
          activeRunIdRef.current = undefined;
          setStatus({ kind: "error", message: getErrorMessage(error) });
          onExitCode(1);
          if (runNextQueuedPrompt()) {
            return;
          }
          if (autoExit) {
            void agentSession.close("prompt_input_exit").finally(() => exit());
          }
        });
    },
    [
      agentSession,
      appendCommittedItems,
      autoExit,
      commitMessage,
      exit,
      onExitCode,
      runNextQueuedPrompt,
      shellCommandRunner,
      updateInput,
    ],
  );
  const requestManualExit = useCallback(() => {
    if (manualExitRequestedRef.current) {
      return;
    }

    manualExitRequestedRef.current = true;
    const finishedAtMs = Date.now();
    userInteractionController.cancelAll("CLI exited before the interaction completed.");
    const activeRunId = activeRunIdRef.current;

    if (activeRunId !== undefined) {
      metricsRef.current?.finishRun(activeRunId, finishedAtMs);
    }
    metricsRef.current?.finishActiveTool(finishedAtMs);
    activeAbortControllerRef.current?.abort();
    activeAbortControllerRef.current = undefined;
    activeRunIdRef.current = undefined;
    commitActiveAssistant();
    commitActiveTool();
    clearQueuedPrompts();
    setStatus({ kind: "idle" });

    const summary = metricsRef.current?.buildSummary(finishedAtMs);

    if (summary !== undefined) {
      appendCommittedItems([
        {
          id: `session-summary:${resolvedSessionId}`,
          kind: "session-summary",
          summary,
        },
      ]);
    }
    setManualExitPending(true);
  }, [
    appendCommittedItems,
    clearQueuedPrompts,
    commitActiveAssistant,
    commitActiveTool,
    resolvedSessionId,
    userInteractionController,
  ]);

  const requestExit = useCallback((): boolean => {
    const nowMs = Date.now();

    if (nowMs - lastCtrlCAtRef.current <= 1000) {
      if (statusBarMessageTimerRef.current !== undefined) {
        clearTimeout(statusBarMessageTimerRef.current);
        statusBarMessageTimerRef.current = undefined;
      }
      requestManualExit();
      return true;
    }

    lastCtrlCAtRef.current = nowMs;
    setStatusBarMessage("Ctrl+C again to exit");
    if (statusBarMessageTimerRef.current !== undefined) {
      clearTimeout(statusBarMessageTimerRef.current);
    }
    statusBarMessageTimerRef.current = setTimeout(() => {
      lastCtrlCAtRef.current = 0;
      statusBarMessageTimerRef.current = undefined;
      setStatusBarMessage(undefined);
    }, 1000);
    return false;
  }, [requestManualExit]);

  const clearTranscript = useCallback(() => {
    const nextGeneration = timelineGeneration + 1;
    const header = createHeaderItem(
      nextGeneration,
      metricsRef.current?.snapshot().model ?? modelFallback,
      workspaceDir,
    );

    stdout.write(CLEAR_TERMINAL_SEQUENCE);
    committedItemsRef.current = [header];
    setCommittedItems([header]);
    setActiveAssistantState(undefined);
    setActiveToolState(undefined);
    const nextRuntimeTimeline = createRuntimeTimelineState(rootAgentId);
    runtimeTimelineRef.current = nextRuntimeTimeline;
    archivedAgentIdsRef.current.clear();
    if (subagentRenderTimerRef.current !== undefined) {
      clearTimeout(subagentRenderTimerRef.current);
      subagentRenderTimerRef.current = undefined;
    }
    setRuntimeTimeline(nextRuntimeTimeline);
    setTimelineGeneration(nextGeneration);
  }, [
    modelFallback,
    rootAgentId,
    setActiveAssistantState,
    setActiveToolState,
    stdout,
    timelineGeneration,
    workspaceDir,
  ]);

  const replaySessionState = useCallback(
    (state: SessionState | undefined) => {
      if (state === undefined) {
        throw new Error("Session state is unavailable for timeline replay.");
      }
      setStaticTranscriptReady(!useStaticTranscript || !hasModelPresentationResolver);
      const nextGeneration = timelineGeneration + 1;
      const items: TimelineItem[] = [
        createHeaderItem(nextGeneration, state.modelKey, state.workspaceDir),
      ];
      for (const entry of state.history.entries) {
        const message = createMessage(entry.role, entry.content);
        items.push({
          id: `message:${message.id}`,
          kind: "message",
          message,
        });
      }
      stdout.write(CLEAR_TERMINAL_SEQUENCE);
      committedItemsRef.current = items;
      setCommittedItems(items);
      setActiveAssistantState(undefined);
      setActiveToolState(undefined);
      const nextRuntimeTimeline = createRuntimeTimelineState(rootAgentId);
      runtimeTimelineRef.current = nextRuntimeTimeline;
      archivedAgentIdsRef.current.clear();
      if (subagentRenderTimerRef.current !== undefined) {
        clearTimeout(subagentRenderTimerRef.current);
        subagentRenderTimerRef.current = undefined;
      }
      setRuntimeTimeline(nextRuntimeTimeline);
      setTimelineGeneration(nextGeneration);
      setOutputStyle(state.outputStyle);
      updateInput("", { cursorIndex: 0 });
    },
    [
      createMessage,
      hasModelPresentationResolver,
      rootAgentId,
      setActiveAssistantState,
      setActiveToolState,
      stdout,
      timelineGeneration,
      updateInput,
      useStaticTranscript,
    ],
  );

  const getSessionStatus = useCallback(() => {
    const snapshot = metricsRef.current?.snapshot();
    return [
      `Session ID: ${resolvedSessionId}`,
      `Model: ${snapshot?.model ?? modelFallback}`,
      `Workspace: ${workspaceDir}`,
      `Access: ${effectiveAccessMode}`,
      `Runtime: ${activeRunIdRef.current === undefined ? status.kind : "processing"}`,
      `Queued prompts: ${queuedPromptsRef.current.length}`,
      `User interaction: ${userInteractionState?.kind ?? "none"}`,
    ].join("\n");
  }, [
    effectiveAccessMode,
    modelFallback,
    resolvedSessionId,
    status.kind,
    userInteractionState?.kind,
    workspaceDir,
  ]);

  const getContextSummary = useCallback(() => {
    const snapshot = metricsRef.current?.snapshot();
    return snapshot === undefined
      ? "Context usage is unavailable."
      : `${formatContextUsageDetails(snapshot.contextTokens, snapshot.contextWindow)}\n\nModel: ${snapshot.model}`;
  }, []);

  const getContextUsage = useCallback(() => {
    const snapshot = metricsRef.current?.snapshot();
    return snapshot === undefined ? undefined : calculateContextUsage(snapshot);
  }, []);

  const getUsageSummary = useCallback(() => {
    const snapshot = metricsRef.current?.snapshot();
    if (snapshot === undefined) {
      return "Usage is unavailable.";
    }

    const modelUsage =
      snapshot.usageByModel.length === 0
        ? ["No model usage recorded."]
        : snapshot.usageByModel.map(
            (usage) =>
              `${usage.model}: ${formatTokenCount(usage.inputTokens)} input, ${formatTokenCount(
                usage.outputTokens,
              )} output, ${formatTokenCount(usage.cachedInputTokens)} cached`,
          );
    const toolCalls = snapshot.toolCalls.reduce((total, tool) => total + tool.calls, 0);
    return [
      ...modelUsage,
      `Tool calls: ${toolCalls}`,
      `Session duration: ${formatDuration(snapshot.wallDurationMs)}`,
    ].join("\n");
  }, []);

  const getTaskSummary = useCallback(() => {
    const snapshot = metricsRef.current?.snapshot();
    const tasks = snapshot?.tasks ?? {
      blocked: 0,
      completed: 0,
      inProgress: 0,
      pending: 0,
    };
    return [
      `Tasks: ${tasks.completed} completed, ${tasks.inProgress} in progress, ${tasks.pending} pending, ${tasks.blocked} blocked`,
      `Active run: ${activeRunIdRef.current === undefined ? "none" : "yes"}`,
      `Queued prompts: ${queuedPromptsRef.current.length}`,
    ].join("\n");
  }, []);

  const runSetup = useCallback(
    async (trigger: "init" | "maintenance") => {
      setStatusBarMessage(
        trigger === "init" ? "Running project setup..." : "Running project maintenance...",
      );
      try {
        await agentSession.setup(trigger, {
          hookTrustApprovalHandler: (request) =>
            userInteractionController.requestHookTrust(SETUP_INTERACTION_RUN_ID, request),
          onHookStatusMessage: setStatusBarMessage,
        });
      } finally {
        setStatusBarMessage(undefined);
      }
    },
    [agentSession, userInteractionController],
  );

  const executeSlashCommand = useCallback(
    (submittedPrompt: string, fromQueue = false): boolean => {
      const resolution = resolveSlashCommand(submittedPrompt, slashCommandsRef.current);
      const continueQueue = () => {
        if (fromQueue) {
          runNextQueuedPrompt();
        }
      };

      if (resolution.kind === "not-slash") {
        return false;
      }

      if (resolution.kind === "unknown") {
        commitMessage("user", submittedPrompt);
        commitMessage("command", `Unknown command: /${resolution.commandName}`, {
          title: "Command Error",
          tone: "error",
        });
        continueQueue();
        return true;
      }

      if (resolution.kind === "invalid") {
        commitMessage("user", submittedPrompt);
        commitMessage("command", `Invalid /${resolution.commandName}: ${resolution.message}`, {
          title: "Command Error",
          tone: "error",
        });
        continueQueue();
        return true;
      }

      if (activeRunIdRef.current !== undefined && resolution.command.execution === "idle") {
        enqueuePrompt(submittedPrompt);
        return true;
      }

      if (resolution.command.kind !== "prompt") {
        commitMessage("user", submittedPrompt);
      }

      const progressLabel = resolution.command.progressLabel;
      let commandExecutionId: number | undefined;
      if (progressLabel !== undefined) {
        commandExecutionIdRef.current += 1;
        commandExecutionId = commandExecutionIdRef.current;
        setActiveCommand({
          executionId: commandExecutionId,
          label: progressLabel,
          startedAtMs: Date.now(),
        });
      }

      const commandContext: SlashCommandContext = {
        cancelActiveRun,
        clearMessages: clearTranscript,
        clearQueuedPrompts,
        clearSession: async () => {
          await agentSession.clear({
            hookTrustApprovalHandler: (request) =>
              userInteractionController.requestHookTrust(SETUP_INTERACTION_RUN_ID, request),
            onHookStatusMessage: setStatusBarMessage,
          });
          metricsRef.current?.resetContext();
          syncPromptStatus();
        },
        clipboard,
        compactContext: async (instructions) => {
          if (agentSession.compact === undefined) {
            throw new Error("Context compaction is unavailable in this session.");
          }
          await agentSession.compact(instructions, {
            hookTrustApprovalHandler: (request) =>
              userInteractionController.requestHookTrust(SETUP_INTERACTION_RUN_ID, request),
            onHookStatusMessage: setStatusBarMessage,
          });
          metricsRef.current?.resetContext();
          syncPromptStatus();
        },
        createAgent: async (intent) => {
          if (agentSession.createAgent === undefined) {
            throw new Error("Agent creation is unavailable in this session.");
          }
          const profile = await agentSession.createAgent(intent, (request) =>
            userInteractionController.askUser(SETUP_INTERACTION_RUN_ID, request),
          );
          const agents =
            (await agentSession.listAgents?.()) ??
            Object.freeze([
              ...agentCommandsRef.current.filter((agent) => agent.id !== profile.id),
              profile,
            ]);
          replaceSlashCommandCatalog(skillCommandsRef.current, agents);
          return profile;
        },
        createSkill: async (intent) => {
          if (agentSession.createSkill === undefined) {
            throw new Error("Skill creation is unavailable in this session.");
          }
          const reservedNames = slashCommandsRef.current
            .filter((command) => command.source !== "skill")
            .flatMap((command) => [command.name, ...(command.aliases ?? [])]);
          const skill = await agentSession.createSkill(intent, reservedNames);
          const skills =
            (await agentSession.skills?.()) ?? Object.freeze([...skillCommandsRef.current, skill]);
          replaceSlashCommandCatalog(skills, agentCommandsRef.current);
          return skill;
        },
        exit: requestManualExit,
        exportSession: async (filePath) => {
          if (agentSession.exportSession === undefined) {
            throw new Error("Session export is unavailable in this session.");
          }
          return agentSession.exportSession(filePath);
        },
        getContextSummary,
        getContextUsage,
        getHookController: () => agentSession.hooks(),
        getMemoryController: () => agentSession.memories?.() ?? Promise.resolve(undefined),
        getSessionStatus,
        getTaskSummary,
        getUsageSummary,
        installSkill: async (source, selector) => {
          if (agentSession.installSkill === undefined) {
            throw new Error("Skill installation is unavailable in this session.");
          }
          const reservedNames = slashCommandsRef.current
            .filter((command) => command.source !== "skill")
            .flatMap((command) => [command.name, ...(command.aliases ?? [])]);
          const skill = await agentSession.installSkill(source, selector, reservedNames);
          const skills =
            (await agentSession.skills?.()) ?? Object.freeze([...skillCommandsRef.current, skill]);
          replaceSlashCommandCatalog(skills, agentCommandsRef.current);
          return skill;
        },
        listAgents: async () => agentSession.listAgents?.() ?? [],
        listCommands: () => slashCommandsRef.current,
        listSkills: () => skillCommandsRef.current,
        lastAssistantText: () => {
          const activeText = activeAssistantRef.current?.text.trim();
          if (activeText) {
            return activeAssistantRef.current?.text;
          }
          const lastItem = committedItemsRef.current.findLast(
            (item) =>
              item.kind === "message" &&
              item.message.role === "assistant" &&
              Boolean(item.message.text.trim()),
          );
          return lastItem?.kind === "message" ? lastItem.message.text : undefined;
        },
        onExitCode,
        removeAgent: async (profileId) => {
          if (agentSession.removeAgent === undefined) {
            throw new Error("Agent removal is unavailable in this session.");
          }
          await agentSession.removeAgent(profileId);
          const agents =
            (await agentSession.listAgents?.()) ??
            agentCommandsRef.current.filter((agent) => agent.id !== profileId);
          replaceSlashCommandCatalog(skillCommandsRef.current, agents);
        },
        runtime: {
          currentModel: async () => agentSession.currentModel?.(),
          mcpStatus: async () => agentSession.mcpStatus?.() ?? [],
          models: async () => agentSession.models?.() ?? [],
          outputStyle: async () => agentSession.outputStyle?.() ?? outputStyle,
          reconnectMcp: async (server) => {
            if (agentSession.reconnectMcp === undefined) {
              throw new Error("MCP management is unavailable in this session.");
            }
            await agentSession.reconnectMcp(server);
          },
          setModel: async (modelKey, options) => {
            if (agentSession.setModel !== undefined) {
              await agentSession.setModel(modelKey, options);
            } else {
              if (agentSession.setCurrentModel === undefined) {
                throw new Error("Model switching is unavailable in this session.");
              }
              await agentSession.setCurrentModel(modelKey);
              if (options.global) {
                await agentSession.setGlobalModel?.(modelKey);
              }
            }
            replaySessionState(await agentSession.stateSnapshot?.());
            await refreshModelPresentation();
          },
          setOutputStyle: async (style) => {
            if (agentSession.setOutputStyle === undefined) {
              throw new Error("Output style changes are unavailable in this session.");
            }
            await agentSession.setOutputStyle(style);
            setOutputStyle(style);
          },
        },
        runAgent: async (profileId, prompt) => {
          if (agentSession.runAgent === undefined) {
            throw new Error("Agent execution is unavailable in this session.");
          }
          return agentSession.runAgent(profileId, prompt);
        },
        runSetup,
        sessions: {
          branch: async (title) => {
            if (agentSession.branch === undefined) {
              throw new Error("Session branching is unavailable in this session.");
            }
            await agentSession.branch(title);
            replaySessionState(await agentSession.stateSnapshot?.());
            await refreshModelPresentation();
          },
          checkpoints: async () => {
            if (agentSession.checkpoints === undefined) {
              throw new Error("Session rewind is unavailable in this session.");
            }
            return agentSession.checkpoints();
          },
          currentSessionId: async () => (await agentSession.stateSnapshot?.())?.sessionId,
          list: async () => agentSession.listSessions?.() ?? [],
          remove: async (sessionId) => {
            if (agentSession.removeSession === undefined) {
              throw new Error("Session removal is unavailable in this session.");
            }
            await agentSession.removeSession(sessionId);
          },
          rename: async (title, sessionId) => {
            if (sessionId !== undefined && agentSession.renameSession !== undefined) {
              await agentSession.renameSession(sessionId, title);
              return;
            }
            if (agentSession.renameCurrent !== undefined) {
              await agentSession.renameCurrent(title);
              return;
            }
            throw new Error("Session rename is unavailable in this session.");
          },
          rewind: async (checkpointId) => {
            if (agentSession.rewind === undefined) {
              throw new Error("Session rewind is unavailable in this session.");
            }
            await agentSession.rewind(checkpointId);
            replaySessionState(await agentSession.stateSnapshot?.());
            await refreshModelPresentation();
          },
          switch: async (sessionId) => {
            if (agentSession.switch === undefined) {
              throw new Error("Session resume is unavailable in this session.");
            }
            await agentSession.switch(sessionId);
            replaySessionState(await agentSession.stateSnapshot?.());
            await refreshModelPresentation();
          },
        },
        showAgent: async (profileId) => {
          if (agentSession.showAgent === undefined) {
            throw new Error("Agent inspection is unavailable in this session.");
          }
          return agentSession.showAgent(profileId);
        },
      };

      void Promise.resolve()
        .then(() => {
          const command = resolution.command;
          if (command.kind === "local") {
            return command.execute(commandContext, resolution.arguments);
          }
          if (command.kind === "prompt") {
            return command.getSubmission(commandContext, resolution.arguments);
          }
          return command.open(commandContext, resolution.arguments);
        })
        .then((result) => {
          if (resolution.command.kind === "interactive") {
            if (result.kind === "error" || result.kind === "success") {
              if (result.message !== undefined) {
                commitMessage("command", result.message, {
                  ...("contextUsage" in result && result.contextUsage !== undefined
                    ? { contextUsage: result.contextUsage }
                    : {}),
                  ...(result.lineColors !== undefined ? { lineColors: result.lineColors } : {}),
                  ...(result.lineIndents !== undefined ? { lineIndents: result.lineIndents } : {}),
                  title: result.title ?? resolution.command.name,
                  tone: result.kind === "error" ? "error" : "default",
                });
              }
              continueQueue();
              return;
            }
            commandOverlayContinuationRef.current = continueQueue;
            setCommandOverlay(result as CommandOverlay);
            return;
          }
          if (result.kind === "submit") {
            startAgentRun(result.prompt, result);
            return;
          }
          if ("message" in result && result.message !== undefined) {
            commitMessage("command", result.message, {
              ...("contextUsage" in result && result.contextUsage !== undefined
                ? { contextUsage: result.contextUsage }
                : {}),
              ...(result.lineColors !== undefined ? { lineColors: result.lineColors } : {}),
              ...(result.lineIndents !== undefined ? { lineIndents: result.lineIndents } : {}),
              title: result.title ?? resolution.command.name,
              tone: result.kind === "error" ? "error" : "default",
            });
          }
          continueQueue();
        })
        .catch((error: unknown) => {
          commitMessage("command", getErrorMessage(error), {
            title: "Command Error",
            tone: "error",
          });
          continueQueue();
        })
        .finally(() => {
          if (commandExecutionId === undefined) {
            return;
          }
          setActiveCommand((current) =>
            current?.executionId === commandExecutionId ? undefined : current,
          );
        });

      return true;
    },
    [
      agentSession,
      cancelActiveRun,
      clearQueuedPrompts,
      clearTranscript,
      clipboard,
      commitMessage,
      enqueuePrompt,
      getContextSummary,
      getContextUsage,
      getSessionStatus,
      getTaskSummary,
      getUsageSummary,
      onExitCode,
      outputStyle,
      replaceSlashCommandCatalog,
      replaySessionState,
      refreshModelPresentation,
      requestManualExit,
      runNextQueuedPrompt,
      runSetup,
      startAgentRun,
      syncPromptStatus,
      userInteractionController,
    ],
  );

  const submitPrompt = useCallback(
    (rawPrompt: string, options: SubmitPromptOptions = {}) => {
      if (manualExitRequestedRef.current || !sessionInputEnabled) {
        return;
      }

      const submittedPrompt = rawPrompt.trim();

      if (!submittedPrompt) {
        return;
      }

      if (options.remember !== false) {
        rememberCommand(submittedPrompt);
      }
      updateInput("", { cursorIndex: 0 });

      const shellQuery = getShellCommandQuery(submittedPrompt);
      if (shellQuery?.command.trim()) {
        if (activeRunIdRef.current !== undefined) {
          enqueuePrompt(submittedPrompt);
          return;
        }
        startShellRun(shellQuery.command);
        return;
      }

      if (executeSlashCommand(submittedPrompt, options.fromQueue === true)) {
        return;
      }

      if (activeRunIdRef.current !== undefined) {
        enqueuePrompt(submittedPrompt);
        return;
      }

      startAgentRun(submittedPrompt);
    },
    [
      enqueuePrompt,
      executeSlashCommand,
      rememberCommand,
      startAgentRun,
      startShellRun,
      sessionInputEnabled,
      updateInput,
    ],
  );
  submitPromptRef.current = submitPrompt;

  useEffect(() => {
    if (messageEvents === undefined) {
      return;
    }

    return messageEvents.subscribe(handleAgentMessage);
  }, [handleAgentMessage, messageEvents]);

  useEffect(() => {
    if (agentSession.skills === undefined && agentSession.listAgents === undefined) {
      return;
    }

    let active = true;
    void Promise.all([
      (agentSession.skills?.() ?? Promise.resolve<readonly CliSkillCommand[]>([])).catch(
        (error: unknown) => {
          if (active) {
            setStatusBarMessage(`Skill commands unavailable: ${getErrorMessage(error)}`);
          }
          return skillCommandsRef.current;
        },
      ),
      (agentSession.listAgents?.() ?? Promise.resolve<readonly SessionSubagentProfile[]>([])).catch(
        () => agentCommandsRef.current,
      ),
    ]).then(([skills, agents]) => {
      if (active) {
        replaceSlashCommandCatalog(skills, agents);
      }
    });

    return () => {
      active = false;
    };
  }, [agentSession, replaceSlashCommandCatalog]);

  useEffect(() => {
    if (agentSession.currentModel === undefined && agentSession.models === undefined) {
      return;
    }

    void refreshModelPresentation().catch(() => {
      // Leave the fallback label in place when the model cannot be resolved yet.
    });
  }, [agentSession, refreshModelPresentation]);

  useEffect(() => {
    if (!manualExitPending) {
      return;
    }

    let active = true;
    void agentSession.close("prompt_input_exit").finally(() => {
      if (active) {
        onExitCode(0);
        exit();
      }
    });

    return () => {
      active = false;
    };
  }, [agentSession, exit, manualExitPending, onExitCode]);

  useEffect(() => {
    if (setupMode === undefined || setupStartedRef.current) {
      return;
    }

    setupStartedRef.current = true;
    setStatusBarMessage(
      setupMode === "init" ? "Running project setup..." : "Running project maintenance...",
    );
    agentSession
      .setup(setupMode, {
        hookTrustApprovalHandler: (request) =>
          userInteractionController.requestHookTrust(SETUP_INTERACTION_RUN_ID, request),
        onHookStatusMessage: setStatusBarMessage,
      })
      .then(() => {
        setStatusBarMessage(undefined);
        if (initOnly) {
          onExitCode(0);
          void agentSession.close("prompt_input_exit").finally(() => exit());
          return;
        }
        setSetupReady(true);
      })
      .catch((error: unknown) => {
        const message = getErrorMessage(error);
        const source = getErrorSource(error);
        setStatusBarMessage(undefined);
        setStatus({ kind: "error", message, ...(source !== undefined ? { source } : {}) });
        onExitCode(1);
        void agentSession.close("other").finally(() => exit());
      });
  }, [agentSession, exit, initOnly, onExitCode, setupMode, userInteractionController]);

  useEffect(() => {
    const startupPrompt =
      prompt.trim() ||
      (continueSession || resumeSessionId !== undefined
        ? "Continue working from the saved Session."
        : "");
    if (!setupReady || initialPromptSubmittedRef.current || !startupPrompt) {
      return;
    }

    initialPromptSubmittedRef.current = true;
    submitPrompt(startupPrompt);
  }, [continueSession, prompt, resumeSessionId, setupReady, submitPrompt]);

  useEffect(() => {
    if (status.kind !== "processing" && activeCommand === undefined) {
      return;
    }

    const interval = setInterval(() => {
      setNowMs(Date.now());
      setSpinnerIndex((currentIndex) => currentIndex + 1);
    }, 250);

    return () => clearInterval(interval);
  }, [activeCommand, status.kind]);

  useEffect(
    () => () => {
      if (statusBarMessageTimerRef.current !== undefined) {
        clearTimeout(statusBarMessageTimerRef.current);
      }
      if (subagentRenderTimerRef.current !== undefined) {
        clearTimeout(subagentRenderTimerRef.current);
        subagentRenderTimerRef.current = undefined;
      }

      userInteractionController.cancelAll("CLI unmounted before the interaction completed.");
      activeAbortControllerRef.current?.abort();
      activeAbortControllerRef.current = undefined;
      activeRunIdRef.current = undefined;
      void agentSession.close("prompt_input_exit");
    },
    [agentSession, userInteractionController],
  );

  const insertInputText = useCallback(
    (text: string) => {
      const normalizedText = normalizeLineBreaks(text);
      const currentInput = inputRef.current;
      const currentCursorIndex = cursorIndexRef.current;
      const nextInput = insertTextAt(currentInput, currentCursorIndex, normalizedText);

      updateInput(nextInput, {
        cursorIndex: currentCursorIndex + normalizedText.length,
      });
    },
    [updateInput],
  );

  const closeCommandOverlay = useCallback(() => {
    setCommandOverlay(undefined);
    const continuation = commandOverlayContinuationRef.current;
    commandOverlayContinuationRef.current = undefined;
    continuation?.();
  }, []);

  const handleCommandOverlayResult = useCallback(
    (result: SlashCommandResult) => {
      if (result.message !== undefined) {
        commitMessage("command", result.message, {
          ...("contextUsage" in result && result.contextUsage !== undefined
            ? { contextUsage: result.contextUsage }
            : {}),
          ...(result.lineColors !== undefined ? { lineColors: result.lineColors } : {}),
          ...(result.lineIndents !== undefined ? { lineIndents: result.lineIndents } : {}),
          title: result.title ?? "Command",
          tone: result.kind === "error" ? "error" : "default",
        });
      }
      closeCommandOverlay();
    },
    [closeCommandOverlay, commitMessage],
  );

  usePaste((text) => {
    if (commandOverlay !== undefined || !sessionInputEnabled) {
      return;
    }
    if (
      userInteractionState?.kind === "mcp-elicitation" ||
      (userInteractionState?.kind === "question" && isQuestionTextInput(userInteractionState))
    ) {
      userInteractionController.updateDraft(
        `${userInteractionState.draft}${normalizeLineBreaks(text)}`,
      );
      return;
    }
    if (userInteractionState !== undefined) {
      return;
    }
    insertInputText(text);
  });

  useInput((typedInput, key) => {
    if (manualExitRequestedRef.current) {
      return;
    }
    if (commandOverlay !== undefined) {
      return;
    }

    if (key.ctrl && typedInput === "c") {
      if (requestExit()) {
        return;
      }

      if (status.kind === "processing") {
        cancelActiveRun("User canceled the active task with Ctrl+C.");
        return;
      }

      if (inputRef.current) {
        updateInput("", { cursorIndex: 0 });
        return;
      }
      return;
    }

    if (!sessionInputEnabled) {
      return;
    }

    if (userInteractionState !== undefined) {
      return;
    }

    if (key.ctrl && typedInput === "u") {
      updateInput("", { cursorIndex: 0 });
      return;
    }

    if (key.escape) {
      if (status.kind === "processing") {
        cancelActiveRun("User canceled the active task with Escape.");
        return;
      }

      if (getActiveMenu().menu === "file") {
        setFileEntriesState([]);
        return;
      }

      updateInput("");
      return;
    }

    if (typedInput === "\n" && !key.return) {
      insertInputText("\n");
      return;
    }

    if (key.tab) {
      applySelectedMenuEntry();
      return;
    }

    if (!key.return && hasLineBreak(typedInput)) {
      const inputBeforeTrailingReturn = typedInput.endsWith("\r")
        ? typedInput.slice(0, -1)
        : undefined;

      if (inputBeforeTrailingReturn !== undefined && !hasLineBreak(inputBeforeTrailingReturn)) {
        const promptInput = inputBeforeTrailingReturn
          ? insertTextAt(inputRef.current, cursorIndexRef.current, inputBeforeTrailingReturn)
          : inputRef.current;
        submitPrompt(promptInput);
        return;
      }

      insertInputText(typedInput);
      return;
    }

    if (key.return) {
      const active = getActiveMenu();

      if (active.menu === "file" && active.length > 0) {
        applySelectedMenuEntry();
        return;
      }

      if (active.menu === "slash" && active.length > 0) {
        const selectedIndex = Math.min(menuSelectedIndexRef.current, active.length - 1);
        const command = getSlashCommandSuggestions(
          inputRef.current,
          cursorIndexRef.current,
          slashCommandsRef.current,
        )[selectedIndex];
        const completion = getSlashCommandQuery(inputRef.current, cursorIndexRef.current);

        if (
          command &&
          completion &&
          inputRef.current.slice(completion.startIndex, completion.endIndex) !== `/${command.name}`
        ) {
          applySelectedMenuEntry();
          return;
        }
      }

      if (key.shift) {
        insertInputText("\n");
        return;
      }

      if (isLineContinuation(inputRef.current, cursorIndexRef.current)) {
        const currentInput = inputRef.current;
        const currentCursorIndex = cursorIndexRef.current;
        updateInput(
          `${currentInput.slice(0, currentCursorIndex - 1)}\n${currentInput.slice(currentCursorIndex)}`,
          { cursorIndex: currentCursorIndex },
        );
        return;
      }

      submitPrompt(inputRef.current);
      return;
    }

    if (key.upArrow) {
      if (moveMenuSelection(-1)) {
        return;
      }

      if (status.kind === "processing" && !inputRef.current && restoreQueuedPrompt()) {
        return;
      }

      if (cursorIndexRef.current > 0) {
        moveCursorVertical("up");
        return;
      }

      restoreHistory("up");
      return;
    }

    if (key.downArrow) {
      if (moveMenuSelection(1)) {
        return;
      }

      if (cursorIndexRef.current < inputRef.current.length) {
        moveCursorVertical("down");
        return;
      }

      restoreHistory("down");
      return;
    }

    if (key.meta && (key.leftArrow || typedInput === "b")) {
      setCursorPosition(moveCursorByWord(inputRef.current, cursorIndexRef.current, "left"));
      return;
    }

    if (key.meta && (key.rightArrow || typedInput === "f")) {
      setCursorPosition(moveCursorByWord(inputRef.current, cursorIndexRef.current, "right"));
      return;
    }

    if (key.home) {
      setCursorPosition(
        moveCursorToLineBoundary(inputRef.current, cursorIndexRef.current, "start"),
      );
      return;
    }

    if (key.end) {
      setCursorPosition(moveCursorToLineBoundary(inputRef.current, cursorIndexRef.current, "end"));
      return;
    }

    if (key.leftArrow) {
      moveCursor(-1);
      return;
    }

    if (key.rightArrow) {
      moveCursor(1);
      return;
    }

    if (key.backspace) {
      const currentInput = inputRef.current;
      const currentCursorIndex = cursorIndexRef.current;

      if (currentCursorIndex > 0) {
        updateInput(
          `${currentInput.slice(0, currentCursorIndex - 1)}${currentInput.slice(currentCursorIndex)}`,
          {
            cursorIndex: currentCursorIndex - 1,
          },
        );
      }
      return;
    }

    if (key.delete) {
      const currentInput = inputRef.current;
      const currentCursorIndex = cursorIndexRef.current;

      if (currentCursorIndex < currentInput.length) {
        updateInput(
          `${currentInput.slice(0, currentCursorIndex)}${currentInput.slice(currentCursorIndex + 1)}`,
          {
            cursorIndex: currentCursorIndex,
          },
        );
      }
      return;
    }

    if (key.ctrl || key.meta) {
      return;
    }

    if (typedInput) {
      insertInputText(typedInput);
    }
  });

  const slashCommandSuggestions = getSlashCommandSuggestions(input, cursorIndex, slashCommands);
  const slashCommandMenuVisible =
    commandOverlay === undefined &&
    userInteractionState === undefined &&
    slashCommandSuggestions.length > 0;
  const isSlashInput = getSlashCommandQuery(input, cursorIndex) !== undefined;
  const isShellInput = getShellCommandQuery(input) !== undefined;
  const promptMaxVisibleColumns = Math.max(PROMPT_MIN_VISIBLE_COLUMNS, terminalSize.columns - 6);
  const promptMaxVisibleRows = Math.max(
    PROMPT_MIN_VISIBLE_ROWS,
    terminalSize.rows - PROMPT_LAYOUT_RESERVED_ROWS,
  );
  const slashCommandMenuMaxVisibleRows = Math.max(
    4,
    Math.min(SLASH_COMMAND_MENU_MAX_VISIBLE_ROWS, terminalSize.rows - PROMPT_LAYOUT_RESERVED_ROWS),
  );

  return (
    <Box flexDirection="column" width="100%">
      <Timeline
        activeCommand={activeCommand}
        activeAssistant={activeAssistant}
        activeTool={activeTool}
        agents={[...runtimeTimeline.agents.values()]}
        generation={timelineGeneration}
        items={committedItems}
        nowMs={nowMs}
        outputStyle={outputStyle}
        spinnerIndex={spinnerIndex}
        staticTranscript={useStaticTranscript && staticTranscriptReady}
        status={status}
      />
      {manualExitPending ? null : (
        <Box flexDirection="column" width="100%">
          {queuedPrompts.length > 0 ? <QueuedPromptList queuedPrompts={queuedPrompts} /> : null}
          {commandOverlay !== undefined ? (
            <CommandOverlayView
              onCancel={closeCommandOverlay}
              onResult={handleCommandOverlayResult}
              overlay={commandOverlay}
            />
          ) : null}
          <PromptInput
            cursorIndex={cursorIndex}
            input={input}
            isShellInput={isShellInput}
            isSlashInput={isSlashInput}
            maxVisibleColumns={promptMaxVisibleColumns}
            maxVisibleRows={promptMaxVisibleRows}
          />
          {commandOverlay !== undefined ? null : userInteractionState !== undefined ? (
            <UserInteractionView
              controller={userInteractionController}
              state={userInteractionState}
            />
          ) : (
            <>
              {fileEntries.length > 0 ? (
                <FileCompletionMenu entries={fileEntries} selectedIndex={menuSelectedIndex} />
              ) : null}
              {slashCommandMenuVisible ? (
                <SlashCommandMenu
                  commands={slashCommandSuggestions}
                  maxVisibleRows={slashCommandMenuMaxVisibleRows}
                  selectedIndex={menuSelectedIndex}
                  terminalColumns={terminalSize.columns}
                />
              ) : null}
            </>
          )}
          {commandOverlay === undefined ? (
            <StatusBar
              contextTokens={promptStatus.contextTokens}
              contextWindow={promptStatus.contextWindow}
              message={statusBarMessage}
              model={promptStatus.model}
              showShortcuts={!slashCommandMenuVisible}
            />
          ) : null}
        </Box>
      )}
    </Box>
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSubagentMessage(timeline: RuntimeTimelineState, message: AgentMessageEnvelope): boolean {
  return (
    message.agentId !== timeline.root.agentId &&
    (message.parentAgentId !== undefined ||
      timeline.agents.has(message.agentId) ||
      message.payload.kind === "agent_spawned" ||
      message.payload.kind === "agent_output" ||
      message.payload.kind === "agent_finished")
  );
}

function attachAgentMessageMetadata(
  timeline: RuntimeTimelineState,
  message: AgentMessageEnvelope,
): RuntimeTimelineState {
  const taskId = message.taskId?.trim();
  const agent = timeline.agents.get(message.agentId);
  if (taskId === undefined || taskId === "" || agent === undefined || agent.taskId === taskId) {
    return timeline;
  }

  const agents = new Map(timeline.agents);
  agents.set(message.agentId, {
    ...agent,
    taskId,
  });
  return {
    ...timeline,
    agents,
  };
}

export function getErrorSource(error: unknown): string | undefined {
  let current = error;
  while (current instanceof Error) {
    const source = current.stack
      ?.split("\n")
      .map((line) => line.trim())
      .find(
        (line) =>
          line.startsWith("at ") &&
          !line.includes("node_modules") &&
          (line.includes("/packages/") || line.includes("/playground/")),
      );
    if (source !== undefined) {
      return source;
    }
    current = current.cause;
  }
  return undefined;
}

function setProcessExitCode(code: number): void {
  process.exitCode = code;
}

function resolveModelFallback(workspaceDir: string, explicitEnv?: EnvVars): string {
  const env = mergeEnv(process.env, loadEnvFile({ cwd: workspaceDir }), explicitEnv ?? {});

  return env.AI_MODEL_NAME?.trim() || env.AI_MODEL?.trim() || "model resolving";
}

function createHeaderItem(
  generation: number,
  model: string,
  workspaceDir: string,
): TimelineHeaderItem {
  return {
    id: `header:${generation}`,
    kind: "header",
    model,
    workspaceDir,
  };
}
