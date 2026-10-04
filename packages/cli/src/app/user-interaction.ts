import type {
  McpElicitationRequest,
  McpElicitationResponse,
  NormalizedUserQuestion,
  NormalizedUserQuestionRequest,
  PermissionRequest,
  PermissionResponse,
  SessionResumeReviewRequest,
  SessionResumeReviewResponse,
  UserQuestionOption,
  UserQuestionRequest,
  UserQuestionResponse,
  WorkspaceWriteAccessRequest,
  WorkspaceWriteAccessResponse,
} from "@yiku/agent-orchestrator";
import { normalizeUserQuestionRequest } from "@yiku/agent-orchestrator";
import type { HookTrustRequest, HookTrustResponse, JsonObject } from "@yiku/hooks";

export const DEFAULT_USER_INTERACTION_TIMEOUT_MS = 60 * 60 * 1_000;

export type WorkspaceAccessMode = "read-only" | "read-write";
export type WorkspaceAccessPersistence = "persistent" | "session";

export type WorkspaceAccessDecision =
  | {
      readonly action: "allow";
      readonly accessMode: WorkspaceAccessMode;
      readonly persistence: WorkspaceAccessPersistence;
    }
  | {
      readonly action: "exit";
    };

export interface WorkspaceAccessOption {
  readonly decision: WorkspaceAccessDecision;
  readonly label: string;
}

export const WORKSPACE_ACCESS_OPTIONS: readonly WorkspaceAccessOption[] = Object.freeze([
  {
    decision: {
      accessMode: "read-write",
      action: "allow",
      persistence: "session",
    },
    label: "仅本次读写",
  },
  {
    decision: {
      accessMode: "read-write",
      action: "allow",
      persistence: "persistent",
    },
    label: "长期读写",
  },
  {
    decision: {
      action: "exit",
    },
    label: "拒绝授权",
  },
]);

interface UserInteractionStateBase {
  readonly error?: string | undefined;
  readonly id: number;
  readonly runId?: number | undefined;
  readonly selectedIndex: number;
}

export interface WorkspaceAccessInteractionState extends UserInteractionStateBase {
  readonly kind: "workspace-access";
  readonly workspaceDir: string;
}

export interface WorkspaceWriteAccessInteractionState extends UserInteractionStateBase {
  readonly kind: "workspace-write-access";
  readonly request: WorkspaceWriteAccessRequest;
}

export interface PermissionInteractionState extends UserInteractionStateBase {
  readonly kind: "permission";
  readonly request: PermissionRequest;
}

export interface HookTrustInteractionState extends UserInteractionStateBase {
  readonly kind: "hook-trust";
  readonly request: HookTrustRequest;
}

export interface McpElicitationInteractionState extends UserInteractionStateBase {
  readonly draft: string;
  readonly kind: "mcp-elicitation";
  readonly request: McpElicitationRequest;
}

export interface ResumeReviewInteractionState extends UserInteractionStateBase {
  readonly kind: "resume-review";
  readonly request: SessionResumeReviewRequest;
}

export interface UserQuestionInteractionState extends UserInteractionStateBase {
  readonly activeQuestionIndex: number;
  readonly customAnswersByQuestion: readonly (string | undefined)[];
  readonly customDraftsByQuestion: readonly (string | undefined)[];
  readonly customInputActive: boolean;
  readonly cursorIndexes: readonly number[];
  readonly draft: string;
  readonly form: NormalizedUserQuestionRequest;
  readonly kind: "question";
  readonly request: UserQuestionRequest;
  readonly reviewActive: boolean;
  readonly reviewSelectedIndex: number;
  readonly selectedIndexesByQuestion: readonly (readonly number[])[];
}

export type UserInteractionState =
  | HookTrustInteractionState
  | McpElicitationInteractionState
  | PermissionInteractionState
  | ResumeReviewInteractionState
  | UserQuestionInteractionState
  | WorkspaceAccessInteractionState
  | WorkspaceWriteAccessInteractionState;

export interface UserInteractionControllerOptions {
  readonly onStateChange: (state: UserInteractionState | undefined) => void;
  readonly timeoutMs?: number | undefined;
}

interface ConfirmationResult<T, TState> {
  readonly error?: string | undefined;
  readonly state?: TState | undefined;
  readonly value?: T | undefined;
}

interface PendingInteraction {
  cancel(reason: string): void;
  confirm(): boolean;
  state: UserInteractionState;
  timeout?: ReturnType<typeof setTimeout> | undefined;
}

export class UserInteractionCanceledError extends Error {
  public override readonly name = "UserInteractionCanceledError";
}

export class UserInteractionController {
  private active?: PendingInteraction | undefined;
  private nextId = 1;
  private readonly queue: PendingInteraction[] = [];
  private readonly timeoutMs: number;

  public constructor(private readonly options: UserInteractionControllerOptions) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_USER_INTERACTION_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("User interaction timeout must be a positive integer.");
    }
    this.timeoutMs = timeoutMs;
  }

  public requestWorkspaceAccess(workspaceDir: string): Promise<WorkspaceAccessDecision> {
    return this.enqueue<WorkspaceAccessInteractionState, WorkspaceAccessDecision>(
      {
        id: this.nextInteractionId(),
        kind: "workspace-access",
        selectedIndex: 0,
        workspaceDir,
      },
      (state) => ({
        value: WORKSPACE_ACCESS_OPTIONS[state.selectedIndex]?.decision ?? { action: "exit" },
      }),
      () => ({ action: "exit" }),
    );
  }

  public requestPermission(runId: number, request: PermissionRequest): Promise<PermissionResponse> {
    return this.enqueue(
      {
        id: this.nextInteractionId(),
        kind: "permission",
        request,
        runId,
        selectedIndex: 2,
      },
      (state) => ({
        value:
          state.selectedIndex === 0
            ? {
                decision: "allow",
                reason: "User approved the permission for this session.",
                scope: "session",
              }
            : state.selectedIndex === 1
              ? {
                  decision: "allow",
                  reason: "User persistently approved the policy.",
                  scope: "persistent",
                }
              : { decision: "deny", reason: "User rejected the operation." },
      }),
      (reason) => ({ decision: "deny", reason }),
    );
  }

  public requestWorkspaceWriteAccess(
    runId: number,
    request: WorkspaceWriteAccessRequest,
  ): Promise<WorkspaceWriteAccessResponse> {
    return this.enqueue(
      {
        id: this.nextInteractionId(),
        kind: "workspace-write-access",
        request,
        runId,
        selectedIndex: 0,
      },
      (state) => ({
        value:
          state.selectedIndex === 0
            ? { decision: "allow", persistence: "session" }
            : state.selectedIndex === 1
              ? { decision: "allow", persistence: "persistent" }
              : { decision: "deny", reason: "User rejected Workspace write access." },
      }),
      (reason) => ({ decision: "deny", reason }),
    );
  }

  public requestHookTrust(runId: number, request: HookTrustRequest): Promise<HookTrustResponse> {
    return this.enqueue(
      {
        id: this.nextInteractionId(),
        kind: "hook-trust",
        request,
        runId,
        selectedIndex: 2,
      },
      (state) => ({
        value:
          state.selectedIndex === 0
            ? {
                decision: "allow",
                reason: "User persistently trusted the Hook.",
                scope: "persistent",
              }
            : state.selectedIndex === 1
              ? {
                  decision: "allow",
                  reason: "User trusted the Hook for this run.",
                  scope: "once",
                }
              : { decision: "deny", reason: "User rejected Hook trust." },
      }),
      (reason) => ({ decision: "deny", reason }),
    );
  }

  public requestMcpElicitation(
    runId: number,
    request: McpElicitationRequest,
  ): Promise<McpElicitationResponse> {
    return this.enqueue<McpElicitationInteractionState, McpElicitationResponse>(
      {
        draft: "{}",
        id: this.nextInteractionId(),
        kind: "mcp-elicitation",
        request,
        runId,
        selectedIndex: 1,
      },
      (state) => confirmMcpElicitation(state),
      () => ({ action: "decline" }),
    );
  }

  public requestResumeReview(
    runId: number,
    request: SessionResumeReviewRequest,
  ): Promise<SessionResumeReviewResponse> {
    return this.enqueue(
      {
        id: this.nextInteractionId(),
        kind: "resume-review",
        request,
        runId,
        selectedIndex: 2,
      },
      (state) => ({
        value: {
          action: (["completed", "retry", "abandon"] as const)[
            state.selectedIndex
          ] as SessionResumeReviewResponse["action"],
        },
      }),
      () => ({ action: "abandon" }),
    );
  }

  public askUser(runId: number, request: UserQuestionRequest): Promise<UserQuestionResponse> {
    const form = normalizeUserQuestionRequest(request);
    return this.enqueue<UserQuestionInteractionState, UserQuestionResponse>(
      {
        activeQuestionIndex: 0,
        customAnswersByQuestion: form.questions.map(() => undefined),
        customDraftsByQuestion: form.questions.map(() => undefined),
        customInputActive: false,
        cursorIndexes: form.questions.map(() => 0),
        draft: "",
        form,
        id: this.nextInteractionId(),
        kind: "question",
        request,
        reviewActive: false,
        reviewSelectedIndex: 0,
        runId,
        selectedIndex: 0,
        selectedIndexesByQuestion: form.questions.map(() => []),
      },
      (state) => confirmUserQuestion(state),
      (reason) => new UserInteractionCanceledError(reason),
    );
  }

  public select(index: number): void {
    const active = this.active;
    if (active === undefined) {
      return;
    }
    const selectedIndex = clamp(index, 0, optionCount(active.state) - 1);
    if (active.state.kind === "question") {
      if (active.state.reviewActive) {
        active.state = {
          ...active.state,
          error: undefined,
          reviewSelectedIndex: selectedIndex,
        };
        this.emit();
        return;
      }
      const question = currentQuestion(active.state);
      const customInputActive = isCustomAnswerIndex(question, selectedIndex);
      const customDraftsByQuestion = saveCurrentCustomDraft(active.state);
      active.state = {
        ...active.state,
        customDraftsByQuestion,
        cursorIndexes: replaceAt(
          active.state.cursorIndexes,
          active.state.activeQuestionIndex,
          selectedIndex,
        ),
        customInputActive,
        draft: customInputActive
          ? (customDraftsByQuestion[active.state.activeQuestionIndex] ??
            active.state.customAnswersByQuestion[active.state.activeQuestionIndex] ??
            "")
          : question.freeText
            ? active.state.draft
            : "",
        error: undefined,
        selectedIndex,
      };
    } else {
      active.state = {
        ...active.state,
        error: undefined,
        selectedIndex,
      };
    }
    this.emit();
  }

  public moveQuestion(offset: number): void {
    const active = this.active;
    if (active?.state.kind !== "question") {
      return;
    }
    if (active.state.form.questions.length <= 1) {
      return;
    }
    const questionCount = active.state.form.questions.length;
    const currentPageIndex = active.state.reviewActive
      ? questionCount
      : active.state.activeQuestionIndex;
    const lastPageIndex =
      active.state.form.source === "structured" ? questionCount : questionCount - 1;
    const nextPageIndex = clamp(currentPageIndex + offset, 0, lastPageIndex);
    const customDraftsByQuestion = saveCurrentCustomDraft(active.state);
    if (nextPageIndex === questionCount) {
      active.state = {
        ...active.state,
        customDraftsByQuestion,
        customInputActive: false,
        draft: "",
        error: undefined,
        reviewActive: true,
      };
      this.emit();
      return;
    }
    const activeQuestionIndex = nextPageIndex;
    const selectedIndex = active.state.cursorIndexes[activeQuestionIndex] as number;
    const question = active.state.form.questions[activeQuestionIndex] as NormalizedUserQuestion;
    const customInputActive = isCustomAnswerIndex(question, selectedIndex);
    active.state = {
      ...active.state,
      activeQuestionIndex,
      customDraftsByQuestion,
      customInputActive,
      draft: customInputActive
        ? (customDraftsByQuestion[activeQuestionIndex] ??
          active.state.customAnswersByQuestion[activeQuestionIndex] ??
          "")
        : "",
      error: undefined,
      reviewActive: false,
      selectedIndex,
    };
    this.emit();
  }

  public toggleQuestionSelection(): void {
    const active = this.active;
    if (
      active?.state.kind !== "question" ||
      active.state.customInputActive ||
      active.state.reviewActive
    ) {
      return;
    }
    const question = active.state.form.questions[active.state.activeQuestionIndex];
    if (
      question === undefined ||
      !question.multiSelect ||
      active.state.selectedIndex >= question.options.length
    ) {
      return;
    }
    const selected = active.state.selectedIndexesByQuestion[
      active.state.activeQuestionIndex
    ] as readonly number[];
    const nextSelected = selected.includes(active.state.selectedIndex)
      ? selected.filter((index) => index !== active.state.selectedIndex)
      : [...selected, active.state.selectedIndex].toSorted((left, right) => left - right);
    active.state = {
      ...active.state,
      error: undefined,
      selectedIndexesByQuestion: replaceAt(
        active.state.selectedIndexesByQuestion,
        active.state.activeQuestionIndex,
        nextSelected,
      ),
    };
    this.emit();
  }

  public exitQuestionCustomInput(): boolean {
    const active = this.active;
    if (active?.state.kind !== "question" || !active.state.customInputActive) {
      return false;
    }
    const selectedIndex = Math.max(0, currentQuestion(active.state).options.length - 1);
    active.state = {
      ...active.state,
      customInputActive: false,
      customDraftsByQuestion: replaceAt(
        active.state.customDraftsByQuestion,
        active.state.activeQuestionIndex,
        undefined,
      ),
      cursorIndexes: replaceAt(
        active.state.cursorIndexes,
        active.state.activeQuestionIndex,
        selectedIndex,
      ),
      draft: "",
      error: undefined,
      selectedIndex,
    };
    this.emit();
    return true;
  }

  public updateDraft(draft: string): void {
    const active = this.active;
    if (
      active === undefined ||
      (active.state.kind !== "mcp-elicitation" && active.state.kind !== "question")
    ) {
      return;
    }
    if (
      active.state.kind === "question" &&
      !active.state.customInputActive &&
      !currentQuestion(active.state).freeText
    ) {
      return;
    }
    active.state = {
      ...active.state,
      draft,
      error: undefined,
    };
    this.emit();
  }

  public confirm(): boolean {
    if (
      this.active?.state.kind === "question" &&
      this.active.state.reviewActive &&
      this.active.state.reviewSelectedIndex === 1
    ) {
      return this.cancelCurrent("User canceled the question review.");
    }
    return this.active?.confirm() ?? false;
  }

  public cancelCurrent(reason = "User canceled the interaction."): boolean {
    const active = this.active;
    if (active === undefined) {
      return false;
    }
    this.active = undefined;
    active.cancel(reason);
    this.activateNext();
    return true;
  }

  public cancelRun(runId: number, reason = "User canceled the active task."): void {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const pending = this.queue[index];
      if (pending?.state.runId === runId) {
        this.queue.splice(index, 1);
        pending.cancel(reason);
      }
    }

    if (this.active?.state.runId === runId) {
      const active = this.active;
      this.active = undefined;
      active.cancel(reason);
      this.activateNext();
    }
  }

  public cancelAll(reason = "CLI exited before the interaction completed."): void {
    const pending = [...(this.active === undefined ? [] : [this.active]), ...this.queue];
    this.active = undefined;
    this.queue.length = 0;
    for (const interaction of pending) {
      interaction.cancel(reason);
    }
    this.options.onStateChange(undefined);
  }

  public isPending(): boolean {
    return this.active !== undefined || this.queue.length > 0;
  }

  private enqueue<TState extends UserInteractionState, TResponse>(
    initialState: TState,
    confirm: (state: TState) => ConfirmationResult<TResponse, TState>,
    cancel: (reason: string) => TResponse | Error,
  ): Promise<TResponse> {
    return new Promise<TResponse>((resolve, reject) => {
      const finish = (interaction: PendingInteraction, result: TResponse | Error) => {
        this.clearInteractionTimeout(interaction);
        if (result instanceof Error) {
          reject(result);
        } else {
          resolve(result);
        }
      };
      const pending: PendingInteraction = {
        cancel: (reason) => finish(pending, cancel(reason)),
        confirm: () => {
          const result = confirm(pending.state as TState);
          if (result.error !== undefined) {
            pending.state = {
              ...pending.state,
              error: result.error,
            };
            this.emit();
            return false;
          }
          if (result.state !== undefined) {
            pending.state = result.state;
          }
          if (result.value === undefined) {
            pending.state = result.state as TState;
            this.emit();
            return false;
          }
          this.active = undefined;
          finish(pending, result.value);
          this.activateNext();
          return true;
        },
        state: initialState,
      };

      if (this.active === undefined) {
        this.active = pending;
        this.startInteractionTimeout(pending);
        this.emit();
      } else {
        this.queue.push(pending);
      }
    });
  }

  private activateNext(): void {
    this.active = this.queue.shift();
    if (this.active !== undefined) {
      this.startInteractionTimeout(this.active);
    }
    this.emit();
  }

  private emit(): void {
    this.options.onStateChange(this.active?.state);
  }

  private nextInteractionId(): number {
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  private startInteractionTimeout(interaction: PendingInteraction): void {
    this.clearInteractionTimeout(interaction);
    interaction.timeout = setTimeout(() => this.timeoutInteraction(interaction), this.timeoutMs);
  }

  private clearInteractionTimeout(interaction: PendingInteraction): void {
    if (interaction.timeout === undefined) {
      return;
    }
    clearTimeout(interaction.timeout);
    interaction.timeout = undefined;
  }

  private timeoutInteraction(interaction: PendingInteraction): void {
    this.active = undefined;
    interaction.cancel("User interaction timed out.");
    this.activateNext();
  }
}

function confirmMcpElicitation(
  state: McpElicitationInteractionState,
): ConfirmationResult<McpElicitationResponse, McpElicitationInteractionState> {
  if (state.selectedIndex === 1) {
    return { value: { action: "decline" } };
  }
  if (state.request.mode === "url") {
    return { value: { action: "accept" } };
  }

  const result = parseJsonObject(state.draft);
  return result === undefined
    ? { error: "请输入有效的 JSON 对象。" }
    : { value: { action: "accept", result } };
}

function confirmUserQuestion(
  state: UserQuestionInteractionState,
): ConfirmationResult<UserQuestionResponse, UserQuestionInteractionState> {
  if (state.reviewActive) {
    if (findFirstUnansweredQuestion(state) !== undefined) {
      return { error: "请先回答所有问题。" };
    }
    return { value: structuredQuestionResponse(state) };
  }

  const question = currentQuestion(state);
  if (question.freeText) {
    const answer = state.draft.trim();
    return answer ? { value: { answer } } : { error: "请输入回答。" };
  }

  if (state.customInputActive) {
    const customAnswer = state.draft.trim();
    if (!customAnswer) {
      return { error: "请输入自定义回答。" };
    }
    const nextState: UserQuestionInteractionState = {
      ...state,
      customAnswersByQuestion: replaceAt(
        state.customAnswersByQuestion,
        state.activeQuestionIndex,
        customAnswer,
      ),
      customDraftsByQuestion: replaceAt(
        state.customDraftsByQuestion,
        state.activeQuestionIndex,
        undefined,
      ),
      customInputActive: false,
      draft: "",
      error: undefined,
      selectedIndexesByQuestion: question.multiSelect
        ? state.selectedIndexesByQuestion
        : replaceAt(state.selectedIndexesByQuestion, state.activeQuestionIndex, []),
    };
    return completeOrAdvanceQuestion(nextState);
  }

  if (state.selectedIndex >= question.options.length) {
    return {
      state: {
        ...state,
        customInputActive: true,
        draft:
          state.customDraftsByQuestion[state.activeQuestionIndex] ??
          state.customAnswersByQuestion[state.activeQuestionIndex] ??
          "",
        error: undefined,
      },
    };
  }

  if (question.multiSelect) {
    if (!hasQuestionAnswer(state, state.activeQuestionIndex)) {
      return { error: "请至少选择一个选项。" };
    }
    return completeOrAdvanceQuestion(state);
  }

  const nextState: UserQuestionInteractionState = {
    ...state,
    customAnswersByQuestion: replaceAt(
      state.customAnswersByQuestion,
      state.activeQuestionIndex,
      undefined,
    ),
    customDraftsByQuestion: replaceAt(
      state.customDraftsByQuestion,
      state.activeQuestionIndex,
      undefined,
    ),
    error: undefined,
    selectedIndexesByQuestion: replaceAt(
      state.selectedIndexesByQuestion,
      state.activeQuestionIndex,
      [state.selectedIndex],
    ),
  };
  return completeOrAdvanceQuestion(nextState);
}

function completeOrAdvanceQuestion(
  state: UserQuestionInteractionState,
): ConfirmationResult<UserQuestionResponse, UserQuestionInteractionState> {
  const nextQuestionIndex = findNextUnansweredQuestion(state);
  if (nextQuestionIndex !== undefined) {
    const selectedIndex = state.cursorIndexes[nextQuestionIndex] as number;
    const question = state.form.questions[nextQuestionIndex] as NormalizedUserQuestion;
    const customInputActive = isCustomAnswerIndex(question, selectedIndex);
    return {
      state: {
        ...state,
        activeQuestionIndex: nextQuestionIndex,
        customInputActive,
        draft: customInputActive
          ? (state.customDraftsByQuestion[nextQuestionIndex] ??
            state.customAnswersByQuestion[nextQuestionIndex] ??
            "")
          : "",
        reviewActive: false,
        selectedIndex,
      },
    };
  }

  if (state.form.source === "legacy") {
    const selectedIndex = (state.selectedIndexesByQuestion[0] as readonly number[])[0] as number;
    const question = state.form.questions[0] as NormalizedUserQuestion;
    const option = question.options[selectedIndex] as UserQuestionOption;
    return {
      value: {
        answer: option.label,
        selectedIndex,
      },
    };
  }

  if (state.form.questions.length === 1) {
    return { value: structuredQuestionResponse(state) };
  }

  return {
    state: {
      ...state,
      customInputActive: false,
      draft: "",
      error: undefined,
      reviewActive: true,
      reviewSelectedIndex: 0,
    },
  };
}

function findNextUnansweredQuestion(state: UserQuestionInteractionState): number | undefined {
  for (let offset = 1; offset <= state.form.questions.length; offset += 1) {
    const questionIndex = (state.activeQuestionIndex + offset) % state.form.questions.length;
    if (!hasQuestionAnswer(state, questionIndex)) {
      return questionIndex;
    }
  }
  return undefined;
}

function findFirstUnansweredQuestion(state: UserQuestionInteractionState): number | undefined {
  const questionIndex = state.form.questions.findIndex(
    (_, index) => !hasQuestionAnswer(state, index),
  );
  return questionIndex >= 0 ? questionIndex : undefined;
}

function hasQuestionAnswer(state: UserQuestionInteractionState, questionIndex: number): boolean {
  return (
    (state.selectedIndexesByQuestion[questionIndex] as readonly number[]).length > 0 ||
    Boolean(state.customAnswersByQuestion[questionIndex]?.trim())
  );
}

function currentQuestion(state: UserQuestionInteractionState): NormalizedUserQuestion {
  return state.form.questions[state.activeQuestionIndex] as NormalizedUserQuestion;
}

function isCustomAnswerIndex(question: NormalizedUserQuestion, selectedIndex: number): boolean {
  return question.allowCustom && !question.freeText && selectedIndex === question.options.length;
}

export function isQuestionTextInput(state: UserQuestionInteractionState): boolean {
  return !state.reviewActive && (state.customInputActive || currentQuestion(state).freeText);
}

function optionCount(state: UserInteractionState): number {
  switch (state.kind) {
    case "workspace-access":
      return WORKSPACE_ACCESS_OPTIONS.length;
    case "workspace-write-access":
      return 3;
    case "resume-review":
      return 3;
    case "mcp-elicitation":
      return 2;
    case "permission":
      return 3;
    case "hook-trust":
      return 3;
    case "question": {
      if (state.reviewActive) {
        return 2;
      }
      const question = currentQuestion(state);
      if (question.freeText) {
        return 1;
      }
      return question.options.length + (question.allowCustom ? 1 : 0);
    }
  }
}

function saveCurrentCustomDraft(
  state: UserQuestionInteractionState,
): readonly (string | undefined)[] {
  if (!state.customInputActive) {
    return state.customDraftsByQuestion;
  }
  return replaceAt(
    state.customDraftsByQuestion,
    state.activeQuestionIndex,
    state.draft || undefined,
  );
}

function structuredQuestionResponse(state: UserQuestionInteractionState): UserQuestionResponse {
  return {
    answers: state.form.questions.map((question, questionIndex) => {
      const selectedIndexes = state.selectedIndexesByQuestion[questionIndex] as readonly number[];
      const selectedAnswers = selectedIndexes.map(
        (selectedIndex) => (question.options[selectedIndex] as UserQuestionOption).label,
      );
      const customAnswer = state.customAnswersByQuestion[questionIndex];
      return {
        answers: [...selectedAnswers, ...(customAnswer !== undefined ? [customAnswer] : [])],
        questionIndex,
        selectedIndexes,
      };
    }),
  };
}

function replaceAt<T>(values: readonly T[], index: number, value: T): readonly T[] {
  const next = [...values];
  next[index] = value;
  return next;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function parseJsonObject(value: string): JsonObject | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : undefined;
  } catch {
    return undefined;
  }
}
