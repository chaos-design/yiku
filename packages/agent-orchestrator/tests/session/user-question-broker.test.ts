import { describe, expect, it, vi } from "vitest";
import {
  UserQuestionBroker,
  UserQuestionError,
  type UserQuestionLifecycleEvent,
} from "../../src/session/user-question-broker.js";

describe("UserQuestionBroker", () => {
  it("keeps a request pending until it is answered", async () => {
    const events: UserQuestionLifecycleEvent[] = [];
    const broker = brokerWithIds(["question-1"], events);
    const pending = broker.request({
      question: "Which database should we use?",
      toolCallId: "call-1",
    });

    expect(broker.snapshot()).toEqual([
      {
        questionId: "question-1",
        request: {
          question: "Which database should we use?",
          toolCallId: "call-1",
        },
      },
    ]);
    expect(events).toEqual([
      {
        questionId: "question-1",
        request: {
          question: "Which database should we use?",
          toolCallId: "call-1",
        },
        type: "requested",
      },
    ]);

    broker.answer("question-1", { answer: "SQLite" });

    await expect(pending.response).resolves.toEqual({ answer: "SQLite" });
    expect(broker.snapshot()).toEqual([]);
    expect(events.at(-1)).toEqual({
      questionId: "question-1",
      type: "resolved",
    });
  });

  it("restores a persisted question with its stable ID", async () => {
    const events: UserQuestionLifecycleEvent[] = [];
    const broker = brokerWithIds([], events);
    const pending = broker.restore({
      questionId: "question-restored",
      request: {
        options: ["A", "B"],
        question: "Choose.",
        toolCallId: "call-1",
      },
    });

    expect(events).toEqual([
      {
        questionId: "question-restored",
        request: {
          options: ["A", "B"],
          question: "Choose.",
          toolCallId: "call-1",
        },
        type: "requested",
      },
    ]);
    broker.answer("question-restored", { answer: "B", selectedIndex: 1 });

    await expect(pending.response).resolves.toEqual({
      answer: "B",
      selectedIndex: 1,
    });
  });

  it("validates option answers without consuming the pending request", async () => {
    const broker = brokerWithIds(["question-1"]);
    const pending = broker.request({
      options: ["PostgreSQL", "SQLite"],
      question: "Choose storage.",
    });

    expect(() =>
      broker.answer("question-1", {
        answer: "Redis",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "USER_QUESTION_INVALID_RESPONSE",
      }),
    );
    expect(broker.snapshot()).toHaveLength(1);

    broker.answer("question-1", { answer: "SQLite" });

    await expect(pending.response).resolves.toEqual({
      answer: "SQLite",
      selectedIndex: 1,
    });
  });

  it("keeps multiple requests isolated", async () => {
    const broker = brokerWithIds(["question-1", "question-2"]);
    const first = broker.request({ question: "First?" });
    const second = broker.request({ question: "Second?" });

    broker.answer("question-2", { answer: "second answer" });
    broker.answer("question-1", { answer: "first answer" });

    await expect(first.response).resolves.toEqual({ answer: "first answer" });
    await expect(second.response).resolves.toEqual({ answer: "second answer" });
  });

  it("validates and resolves structured question forms", async () => {
    const broker = brokerWithIds(["question-1"]);
    const pending = broker.request({
      questions: [
        {
          header: "数据库",
          multiSelect: false,
          options: [
            { description: "生产数据库", label: "PostgreSQL" },
            { description: "本地数据库", label: "SQLite" },
          ],
          question: "选择数据库。",
        },
        {
          header: "检查",
          multiSelect: true,
          options: [
            { description: "运行测试", label: "测试" },
            { description: "运行静态检查", label: "Lint" },
          ],
          question: "选择检查项。",
        },
      ],
    });
    const response = {
      answers: [
        { answers: ["SQLite"], questionIndex: 0, selectedIndexes: [1] },
        {
          answers: ["测试", "端到端检查"],
          questionIndex: 1,
          selectedIndexes: [0],
        },
      ],
    };

    broker.answer("question-1", response);

    await expect(pending.response).resolves.toEqual(response);
  });

  it("keeps a structured request pending after an invalid answer", () => {
    const broker = brokerWithIds(["question-1"]);
    broker.request({
      questions: [
        {
          header: "数据库",
          multiSelect: false,
          options: [
            { description: "生产数据库", label: "PostgreSQL" },
            { description: "本地数据库", label: "SQLite" },
          ],
          question: "选择数据库。",
        },
      ],
    });

    expect(() =>
      broker.answer("question-1", {
        answers: [
          {
            answers: ["PostgreSQL", "SQLite"],
            questionIndex: 0,
            selectedIndexes: [0, 1],
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "USER_QUESTION_INVALID_RESPONSE",
      }),
    );
    expect(broker.snapshot()).toHaveLength(1);
  });

  it("isolates a pending question from later request mutations", async () => {
    const broker = brokerWithIds(["question-1"]);
    const options = ["A", "B"];
    const pending = broker.request({ options, question: "Choose." });

    options[0] = "Changed";
    broker.answer("question-1", { answer: "A" });

    await expect(pending.response).resolves.toEqual({
      answer: "A",
      selectedIndex: 0,
    });
  });

  it("distinguishes unknown and already settled question IDs", async () => {
    const broker = brokerWithIds(["question-1"]);
    const pending = broker.request({ question: "Continue?" });
    broker.answer("question-1", { answer: "Yes" });
    await pending.response;

    expect(() => broker.answer("missing", { answer: "Yes" })).toThrowError(
      expect.objectContaining({
        code: "USER_QUESTION_NOT_FOUND",
      }),
    );
    expect(() => broker.answer("question-1", { answer: "Yes" })).toThrowError(
      expect.objectContaining({
        code: "USER_QUESTION_ALREADY_SETTLED",
      }),
    );
  });

  it("cancels one request or all pending requests", async () => {
    const events: UserQuestionLifecycleEvent[] = [];
    const broker = brokerWithIds(["question-1", "question-2"], events);
    const first = broker.request({ question: "First?" });
    const second = broker.request({ question: "Second?" });

    broker.cancel("question-1", "User skipped the question.");
    broker.cancelAll("Run canceled.");

    await expect(first.response).rejects.toMatchObject({
      code: "USER_QUESTION_CANCELLED",
      message: "User skipped the question.",
      name: "UserQuestionError",
    });
    await expect(second.response).rejects.toMatchObject({
      code: "USER_QUESTION_CANCELLED",
      message: "Run canceled.",
      name: "UserQuestionError",
    });
    expect(events.slice(-2)).toEqual([
      {
        questionId: "question-1",
        reason: "User skipped the question.",
        type: "cancelled",
      },
      {
        questionId: "question-2",
        reason: "Run canceled.",
        type: "cancelled",
      },
    ]);
  });

  it("does not expose free-text answers in lifecycle events", async () => {
    const events: UserQuestionLifecycleEvent[] = [];
    const broker = brokerWithIds(["question-1"], events);
    const pending = broker.request({ question: "Secret?" });

    broker.answer("question-1", { answer: "sensitive answer" });
    await pending.response;

    expect(JSON.stringify(events)).not.toContain("sensitive answer");
  });

  it("isolates lifecycle listener failures", async () => {
    const listener = vi.fn(() => {
      throw new Error("observer failed");
    });
    const broker = new UserQuestionBroker({
      createId: () => "question-1",
      onEvent: listener,
    });

    const pending = broker.request({ question: "Continue?" });
    expect(() => broker.answer("question-1", { answer: "Yes" })).not.toThrow();
    await expect(pending.response).resolves.toEqual({ answer: "Yes" });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("rejects empty free-text answers and invalid selected indexes", () => {
    const broker = brokerWithIds(["question-1", "question-2"]);
    broker.request({ question: "Explain." });
    broker.request({ options: ["A", "B"], question: "Choose." });

    expect(() => broker.answer("question-1", { answer: " " })).toThrow(UserQuestionError);
    expect(() =>
      broker.answer("question-2", {
        answer: "A",
        selectedIndex: 1,
      }),
    ).toThrow(UserQuestionError);
    expect(broker.snapshot()).toHaveLength(2);
  });

  it("rejects malformed structured requests before array operations", () => {
    const broker = brokerWithIds(["question-1"]);

    expect(() => broker.request({ questions: undefined } as never)).toThrow(/question|questions/iu);
    expect(broker.snapshot()).toEqual([]);
  });
});

function brokerWithIds(
  ids: string[],
  events: UserQuestionLifecycleEvent[] = [],
): UserQuestionBroker {
  let index = 0;
  return new UserQuestionBroker({
    createId: () => ids[index++] ?? `question-${index}`,
    onEvent: (event) => events.push(event),
  });
}
