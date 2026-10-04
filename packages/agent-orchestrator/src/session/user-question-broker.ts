import { randomUUID } from "node:crypto";
import {
  isStructuredUserQuestionRequest,
  normalizeUserQuestionResponse,
  parseUserQuestionInput,
  type UserQuestionRequest,
  type UserQuestionResponse,
} from "@yiku/agent-code";
import { deepFreeze } from "./deep-freeze.js";

const SETTLED_QUESTION_LIMIT = 1_000;

export type UserQuestionErrorCode =
  | "USER_QUESTION_ALREADY_SETTLED"
  | "USER_QUESTION_CANCELLED"
  | "USER_QUESTION_INVALID_RESPONSE"
  | "USER_QUESTION_NOT_FOUND";

export class UserQuestionError extends Error {
  public override readonly name = "UserQuestionError";

  public constructor(
    public readonly code: UserQuestionErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface PendingUserQuestion {
  readonly questionId: string;
  readonly request: UserQuestionRequest;
}

export type UserQuestionLifecycleEvent =
  | {
      readonly questionId: string;
      readonly request: UserQuestionRequest;
      readonly type: "requested";
    }
  | {
      readonly questionId: string;
      readonly selectedIndex?: number | undefined;
      readonly type: "resolved";
    }
  | {
      readonly questionId: string;
      readonly reason: string;
      readonly type: "cancelled";
    };

export interface UserQuestionBrokerOptions {
  readonly createId?: (() => string) | undefined;
  readonly onEvent?: ((event: UserQuestionLifecycleEvent) => void) | undefined;
}

export interface UserQuestionPendingResult {
  readonly questionId: string;
  readonly response: Promise<UserQuestionResponse>;
}

interface PendingEntry extends PendingUserQuestion {
  readonly reject: (error: UserQuestionError) => void;
  readonly resolve: (response: UserQuestionResponse) => void;
}

export class UserQuestionBroker {
  private readonly createId: () => string;
  private readonly onEvent?: ((event: UserQuestionLifecycleEvent) => void) | undefined;
  private readonly pending = new Map<string, PendingEntry>();
  private readonly settled = new Set<string>();
  private readonly settledOrder: string[] = [];

  public constructor(options: UserQuestionBrokerOptions = {}) {
    this.createId = options.createId ?? randomUUID;
    this.onEvent = options.onEvent;
  }

  public request(request: UserQuestionRequest): UserQuestionPendingResult {
    return this.createPending(this.nextId(), request);
  }

  public restore(pending: PendingUserQuestion): UserQuestionPendingResult {
    return this.createPending(this.requireNewId(pending.questionId), pending.request);
  }

  private createPending(
    questionId: string,
    request: UserQuestionRequest,
  ): UserQuestionPendingResult {
    const input = parseUserQuestionInput(request);
    const storedRequest = freezeRequest({
      ...input,
      ...(request.toolCallId !== undefined ? { toolCallId: request.toolCallId } : {}),
    });
    let resolveResponse: ((response: UserQuestionResponse) => void) | undefined;
    let rejectResponse: ((error: UserQuestionError) => void) | undefined;
    const response = new Promise<UserQuestionResponse>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    if (resolveResponse === undefined || rejectResponse === undefined) {
      throw new Error("Unable to initialize user question.");
    }

    this.pending.set(questionId, {
      questionId,
      reject: rejectResponse,
      request: storedRequest,
      resolve: resolveResponse,
    });
    this.emit({
      questionId,
      request: storedRequest,
      type: "requested",
    });

    return {
      questionId,
      response,
    };
  }

  public answer(questionId: string, response: UserQuestionResponse): void {
    const pending = this.requirePending(questionId);
    let normalized: UserQuestionResponse;
    try {
      normalized = normalizeUserQuestionResponse(pending.request, response);
    } catch (error) {
      throw new UserQuestionError(
        "USER_QUESTION_INVALID_RESPONSE",
        error instanceof Error ? error.message : String(error),
      );
    }

    this.pending.delete(questionId);
    this.markSettled(questionId);
    pending.resolve(normalized);
    this.emit({
      questionId,
      ...("selectedIndex" in normalized && normalized.selectedIndex !== undefined
        ? { selectedIndex: normalized.selectedIndex }
        : {}),
      type: "resolved",
    });
  }

  public cancel(questionId: string, reason = "User question was canceled."): void {
    const pending = this.requirePending(questionId);

    this.pending.delete(questionId);
    this.markSettled(questionId);
    pending.reject(new UserQuestionError("USER_QUESTION_CANCELLED", reason));
    this.emit({
      questionId,
      reason,
      type: "cancelled",
    });
  }

  public cancelAll(reason = "User questions were canceled."): void {
    for (const questionId of [...this.pending.keys()]) {
      this.cancel(questionId, reason);
    }
  }

  public snapshot(): readonly PendingUserQuestion[] {
    return Object.freeze(
      [...this.pending.values()].map(({ questionId, request }) =>
        Object.freeze({
          questionId,
          request,
        }),
      ),
    );
  }

  private emit(event: UserQuestionLifecycleEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // Observers cannot change user question execution.
    }
  }

  private nextId(): string {
    return this.requireNewId(this.createId());
  }

  private requireNewId(value: string): string {
    const questionId = value.trim();
    if (!questionId) {
      throw new Error("User question ID must be non-empty.");
    }
    if (this.pending.has(questionId) || this.settled.has(questionId)) {
      throw new Error(`User question ID already exists: ${questionId}.`);
    }
    return questionId;
  }

  private markSettled(questionId: string): void {
    this.settled.add(questionId);
    this.settledOrder.push(questionId);
    if (this.settledOrder.length <= SETTLED_QUESTION_LIMIT) {
      return;
    }
    const expired = this.settledOrder.shift();
    if (expired !== undefined) {
      this.settled.delete(expired);
    }
  }

  private requirePending(questionId: string): PendingEntry {
    const pending = this.pending.get(questionId);
    if (pending !== undefined) {
      return pending;
    }
    if (this.settled.has(questionId)) {
      throw new UserQuestionError(
        "USER_QUESTION_ALREADY_SETTLED",
        `User question is already settled: ${questionId}.`,
      );
    }
    throw new UserQuestionError(
      "USER_QUESTION_NOT_FOUND",
      `User question was not found: ${questionId}.`,
    );
  }
}

function freezeRequest(request: UserQuestionRequest): UserQuestionRequest {
  if (isStructuredUserQuestionRequest(request)) {
    return deepFreeze({
      ...request,
      questions: request.questions.map((question) => ({
        ...question,
        options: question.options.map((option) => ({ ...option })),
      })),
    });
  }
  const options = request.options === undefined ? undefined : [...request.options];
  if (options !== undefined) {
    Object.freeze(options);
  }
  return Object.freeze({
    ...request,
    ...(options !== undefined ? { options } : {}),
  });
}
