import { Menu, PanelRight, Radio, Settings2 } from "lucide-react";
import {
  type Dispatch,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  cancelTurn,
  createThread,
  createTurn,
  deleteThread,
  getObservatoryStatus,
  getThread,
  getTurn,
  listThreads,
  subscribeTurnEvents,
} from "./api.js";
import { ChatComposer } from "./components/chat-composer.js";
import { ConfirmDialog } from "./components/confirm-dialog.js";
import { MessageList } from "./components/message-list.js";
import { ResearchInspector } from "./components/research-inspector.js";
import { SettingsDialog } from "./components/settings-dialog.js";
import { ThreadSidebar } from "./components/thread-sidebar.js";
import { Button } from "./components/ui/button.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip.js";
import {
  availableSkillPresets,
  buildResearchTurnOptions,
  loadResearchSettings,
  saveResearchSettings,
  selectedSkillPreset,
} from "./research-settings.js";
import {
  activeTurn,
  type ConversationAction,
  conversationReducer,
  INITIAL_CONVERSATION_STATE,
} from "./state/conversation-state.js";
import {
  INITIAL_RUN_STATE,
  type RunAction,
  runReducer,
  selectFlowEdges,
  selectFlowNodes,
  selectTimelineEvents,
} from "./state/run-reducer.js";
import type {
  ObservatoryStatus,
  ResearchRunSnapshot,
  ResearchThreadSnapshot,
  ResearchThreadSummary,
  ResearchTurnSnapshot,
  ResearchTurnSummary,
} from "./types.js";

export function App() {
  const [conversation, dispatch] = useReducer(conversationReducer, INITIAL_CONVERSATION_STATE);
  const [runState, dispatchRun] = useReducer(runReducer, INITIAL_RUN_STATE);
  const [prompt, setPrompt] = useState("");
  const [settings, setSettings] = useState(loadResearchSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState<ResearchThreadSummary>();
  const [deletingThreadId, setDeletingThreadId] = useState<string>();
  const [leftOpen, setLeftOpen] = useState(false);
  const [observatory, setObservatory] = useState<ObservatoryStatus>({
    available: false,
    url: "",
  });
  const [rightOpen, setRightOpen] = useState(false);
  const subscriptionRef = useRef<(() => void) | undefined>(undefined);
  const active = activeTurn(conversation);
  const selectedTurn = conversation.selectedTurn;
  const edges = useMemo(() => selectFlowEdges(runState), [runState]);
  const nodes = useMemo(() => selectFlowNodes(runState), [runState]);
  const timelineEvents = useMemo(() => selectTimelineEvents(runState), [runState]);
  const skillOptions = useMemo(() => availableSkillPresets(settings), [settings]);
  const selectedSkill = useMemo(() => selectedSkillPreset(settings), [settings]);

  const refreshThreads = useCallback(async () => {
    const threads = await listThreads();
    dispatch({ threads, type: "threads_loaded" });
    return threads;
  }, []);

  const selectThread = useCallback(async (threadId: string) => {
    subscriptionRef.current?.();
    subscriptionRef.current = undefined;
    const thread = await getThread(threadId);
    dispatch({ thread, type: "thread_selected" });
    const latestTurn = thread.turns.at(-1);
    if (latestTurn !== undefined) {
      dispatchRun({ snapshot: toRunSnapshot(latestTurn), type: "load" });
      if (latestTurn.status === "queued" || latestTurn.status === "running") {
        connectTurn(latestTurn, dispatch, dispatchRun, subscriptionRef);
      }
    } else {
      dispatchRun({ type: "reset" });
    }
    setLeftOpen(false);
  }, []);

  useEffect(() => {
    saveResearchSettings(settings);
  }, [settings]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    let mounted = true;
    void refreshThreads().then(
      (threads) => {
        if (mounted && threads[0] !== undefined) {
          void selectThread(threads[0].threadId);
        }
      },
      (error: unknown) => {
        if (mounted) {
          dispatch({ error: errorMessage(error), type: "request_failed" });
        }
      },
    );
    return () => {
      mounted = false;
      subscriptionRef.current?.();
    };
  }, [refreshThreads, selectThread]);

  useEffect(() => {
    let mounted = true;
    let timer: number | undefined;
    const refresh = async () => {
      try {
        const status = await getObservatoryStatus();
        if (mounted) {
          setObservatory(status);
        }
      } catch {
        if (mounted) {
          setObservatory((current) => ({ ...current, available: false }));
        }
      } finally {
        if (mounted) {
          timer = window.setTimeout(refresh, 2_000);
        }
      }
    };
    void refresh();
    return () => {
      mounted = false;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, []);

  const handleNewThread = useCallback(async () => {
    subscriptionRef.current?.();
    subscriptionRef.current = undefined;
    dispatch({ type: "clear_error" });
    try {
      const thread = await createThread();
      dispatch({ thread, type: "thread_created" });
      dispatchRun({ type: "reset" });
      setLeftOpen(false);
      setPrompt("");
    } catch (error) {
      dispatch({ error: errorMessage(error), type: "request_failed" });
    }
  }, []);

  const handleDeleteThread = useCallback(
    async (threadId: string) => {
      const thread = conversation.threads.find((candidate) => candidate.threadId === threadId);
      if (thread === undefined) {
        return;
      }
      const selected = conversation.selectedThread?.threadId === threadId;
      setDeletingThreadId(threadId);
      dispatch({ type: "clear_error" });
      if (selected) {
        subscriptionRef.current?.();
        subscriptionRef.current = undefined;
      }
      let deleted = false;
      try {
        await deleteThread(threadId);
        deleted = true;
        dispatch({ threadId, type: "thread_deleted" });
        const threads = await refreshThreads();
        if (selected) {
          dispatchRun({ type: "reset" });
          setLeftOpen(false);
          const next = threads[0];
          if (next !== undefined) {
            await selectThread(next.threadId);
          }
        }
      } catch (error) {
        dispatch({ error: errorMessage(error), type: "request_failed" });
        if (!deleted && selected && active !== undefined) {
          connectTurn(active, dispatch, dispatchRun, subscriptionRef);
        }
      } finally {
        setDeletingThreadId(undefined);
        setDeleteCandidate(undefined);
      }
    },
    [
      active,
      conversation.selectedThread?.threadId,
      conversation.threads,
      refreshThreads,
      selectThread,
    ],
  );

  const ensureThread = useCallback(async (): Promise<ResearchThreadSnapshot> => {
    if (conversation.selectedThread !== undefined) {
      return conversation.selectedThread;
    }
    const created = await createThread();
    dispatch({ thread: created, type: "thread_created" });
    return {
      ...created,
      messages: [],
      turns: [],
    };
  }, [conversation.selectedThread]);

  const handleSubmit = useCallback(async () => {
    const value = prompt.trim();
    if (!value || submitting || active !== undefined) {
      return;
    }
    setSubmitting(true);
    dispatch({ type: "clear_error" });
    try {
      const thread = await ensureThread();
      const turn = await createTurn(
        thread.threadId,
        value,
        selectedSkill.baseSkill,
        buildResearchTurnOptions(settings, selectedSkill),
      );
      const updatedThread = await getThread(thread.threadId);
      const turnSnapshot =
        updatedThread.turns.find((candidate) => candidate.turnId === turn.turnId) ??
        toTurnSnapshot(turn);
      dispatch({ thread: updatedThread, type: "thread_selected" });
      dispatchRun({ snapshot: toRunSnapshot(turnSnapshot), type: "load" });
      setPrompt("");
      connectTurn(turnSnapshot, dispatch, dispatchRun, subscriptionRef, async () => {
        await Promise.all([refreshThreads(), selectThread(thread.threadId)]);
      });
    } catch (error) {
      dispatch({ error: errorMessage(error), type: "request_failed" });
    } finally {
      setSubmitting(false);
    }
  }, [
    active,
    ensureThread,
    prompt,
    refreshThreads,
    selectedSkill,
    selectThread,
    settings,
    submitting,
  ]);

  const handleCancel = useCallback(async () => {
    if (active === undefined) {
      return;
    }
    try {
      await cancelTurn(active.turnId);
    } catch (error) {
      dispatch({ error: errorMessage(error), type: "request_failed" });
    }
  }, [active]);

  const currentTitle = conversation.selectedThread?.title ?? "New research";
  const busy = submitting || active !== undefined;

  return (
    <div
      className={`research-app${leftOpen ? " is-left-open" : ""}${
        rightOpen ? " is-right-open" : ""
      }`}
    >
      <ThreadSidebar
        deletingThreadId={deletingThreadId}
        onDelete={(threadId) =>
          setDeleteCandidate(conversation.threads.find((thread) => thread.threadId === threadId))
        }
        onNewThread={() => void handleNewThread()}
        onSelect={(threadId) => void selectThread(threadId)}
        selectedThreadId={conversation.selectedThread?.threadId}
        threads={conversation.threads}
      />

      <main className="conversation-main">
        <header className="conversation-header">
          <button
            aria-label="打开会话列表"
            className="mobile-panel-button"
            onClick={() => setLeftOpen((value) => !value)}
            type="button"
          >
            <Menu size={17} />
          </button>
          <div>
            <span>RESEARCH THREAD</span>
            <strong>{currentTitle}</strong>
          </div>
          <div className="conversation-header-actions">
            <div className="conversation-runtime">
              <span className={`connection-dot is-${conversation.connection}`} />
              <small>{connectionLabel(conversation.connection)}</small>
              <strong>{selectedTurn?.model ?? "RESEARCH AGENT"}</strong>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="打开 Research 设置"
                  className="research-settings-trigger"
                  onClick={() => setSettingsOpen(true)}
                  size="icon"
                  variant="ghost"
                >
                  <Settings2 data-icon="inline-start" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Research 设置</TooltipContent>
            </Tooltip>
            <button
              aria-label="打开研究详情"
              className="mobile-panel-button"
              onClick={() => setRightOpen((value) => !value)}
              type="button"
            >
              <PanelRight size={17} />
            </button>
          </div>
        </header>

        <div className="conversation-scroll">
          <MessageList
            messages={conversation.selectedThread?.messages ?? []}
            onExample={setPrompt}
            turn={selectedTurn}
            turns={conversation.selectedThread?.turns ?? []}
          />
        </div>

        <div className="conversation-composer">
          {conversation.error ? (
            <div className="conversation-error" role="alert">
              <Radio size={12} />
              {conversation.error}
            </div>
          ) : null}
          <ChatComposer
            busy={busy}
            onCancel={() => void handleCancel()}
            onChange={setPrompt}
            onOpenSettings={() => setSettingsOpen(true)}
            onSkillChange={(skillId) =>
              setSettings((current) => ({ ...current, defaultSkillId: skillId }))
            }
            onSubmit={() => void handleSubmit()}
            selectedSkillId={selectedSkill.id}
            sendMode={settings.sendMode}
            skillOptions={skillOptions}
            value={prompt}
          />
          <p>Research Agent 可能出错。关键结论应检查其 Evidence Ledger 与原始来源。</p>
        </div>
      </main>

      <ResearchInspector
        edges={edges}
        events={timelineEvents}
        nodes={nodes}
        observatory={observatory}
        turn={selectedTurn}
      />

      {leftOpen || rightOpen ? (
        <button
          aria-label="关闭侧栏"
          className="panel-backdrop"
          onClick={() => {
            setLeftOpen(false);
            setRightOpen(false);
          }}
          type="button"
        />
      ) : null}

      {deleteCandidate !== undefined ? (
        <ConfirmDialog
          busy={deletingThreadId === deleteCandidate.threadId}
          confirmLabel="删除会话"
          description={`确定删除研究会话“${deleteCandidate.title}”吗？此操作无法撤销。`}
          onCancel={() => setDeleteCandidate(undefined)}
          onConfirm={() => void handleDeleteThread(deleteCandidate.threadId)}
          title="删除研究会话"
        />
      ) : null}

      <SettingsDialog
        onOpenChange={setSettingsOpen}
        onSettingsChange={setSettings}
        open={settingsOpen}
        settings={settings}
      />
    </div>
  );
}

function connectTurn(
  turn: ResearchTurnSnapshot,
  dispatch: Dispatch<ConversationAction>,
  dispatchRun: Dispatch<RunAction>,
  subscriptionRef: { current: (() => void) | undefined },
  onTerminal?: () => Promise<void>,
): void {
  subscriptionRef.current?.();
  subscriptionRef.current = subscribeTurnEvents({
    afterId: turn.events.at(-1)?.id ?? 0,
    onConnectionChange: (connection) => {
      dispatch({ connection, type: "connection_changed" });
      if (connection === "disconnected") {
        void getTurn(turn.turnId).then(
          (snapshot) => {
            dispatch({ snapshot, type: "turn_loaded" });
            dispatchRun({ snapshot: toRunSnapshot(snapshot), type: "load" });
          },
          (error: unknown) => {
            dispatch({ error: errorMessage(error), type: "request_failed" });
          },
        );
      }
    },
    onError: (error) => {
      dispatch({ error: error.message, type: "request_failed" });
    },
    onEvent: (event) => {
      dispatch({ event, type: "event_received" });
      dispatchRun({ event, type: "receive" });
      if (
        event.type === "status" &&
        (event.data.status === "cancelled" ||
          event.data.status === "completed" ||
          event.data.status === "failed")
      ) {
        void onTerminal?.();
      }
    },
    turnId: turn.turnId,
  });
}

function toTurnSnapshot(turn: ResearchTurnSummary): ResearchTurnSnapshot {
  return {
    ...turn,
    events: [],
    evidence: [],
    streamedText: "",
  };
}

function toRunSnapshot(turn: ResearchTurnSnapshot): ResearchRunSnapshot {
  return {
    createdAt: turn.createdAt,
    ...(turn.error !== undefined ? { error: turn.error } : {}),
    events: turn.events,
    ...(turn.model !== undefined ? { model: turn.model } : {}),
    ...(turn.output !== undefined ? { output: turn.output } : {}),
    prompt: turn.prompt,
    runId: turn.turnId,
    status: turn.status,
    streamedText: turn.streamedText,
    updatedAt: turn.updatedAt,
    ...(turn.usage !== undefined ? { usage: turn.usage } : {}),
    ...(turn.validation !== undefined ? { validation: turn.validation } : {}),
  };
}

function connectionLabel(status: typeof INITIAL_CONVERSATION_STATE.connection): string {
  switch (status) {
    case "live":
      return "LIVE";
    case "connecting":
      return "CONNECTING";
    case "disconnected":
      return "RECONNECTING";
    case "idle":
      return "LOCAL";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
