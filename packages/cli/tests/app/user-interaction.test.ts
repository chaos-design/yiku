import type { PermissionRequest, SessionResumeReviewRequest } from "@yiku/agent-orchestrator";
import type { HookTrustRequest } from "@yiku/hooks";
import { describe, expect, it, vi } from "vitest";
import {
  UserInteractionCanceledError,
  UserInteractionController,
  type UserInteractionState,
} from "../../src/app/user-interaction.js";

describe("UserInteractionController", () => {
  it("resolves startup workspace access", async () => {
    const { controller, state } = setupController();
    const response = controller.requestWorkspaceAccess("/workspace");

    expect(state.current).toMatchObject({
      kind: "workspace-access",
      selectedIndex: 0,
      workspaceDir: "/workspace",
    });
    controller.select(0);
    expect(controller.confirm()).toBe(true);

    await expect(response).resolves.toEqual({
      accessMode: "read-write",
      action: "allow",
      persistence: "session",
    });
    expect(state.current).toBeUndefined();
  });

  it("upgrades Workspace write access for the Session or persistently", async () => {
    const session = setupController();
    const sessionResponse = session.controller.requestWorkspaceWriteAccess(1, {
      action: "edit",
      subject: "src/index.ts",
      workspaceId: "workspace-1",
    });
    session.controller.confirm();
    await expect(sessionResponse).resolves.toEqual({
      decision: "allow",
      persistence: "session",
    });

    const persistent = setupController();
    const persistentResponse = persistent.controller.requestWorkspaceWriteAccess(1, {
      action: "shell",
      subject: "npm version patch",
      workspaceId: "workspace-1",
    });
    persistent.controller.select(1);
    persistent.controller.confirm();
    await expect(persistentResponse).resolves.toEqual({
      decision: "allow",
      persistence: "persistent",
    });
  });

  it("maps Permission selections to Session and persistent scopes", async () => {
    const session = setupController();
    const sessionResponse = session.controller.requestPermission(1, permissionRequest());
    session.controller.select(0);
    session.controller.confirm();
    await expect(sessionResponse).resolves.toEqual({
      decision: "allow",
      reason: "User approved the permission for this session.",
      scope: "session",
    });

    const persistent = setupController();
    const persistentResponse = persistent.controller.requestPermission(1, permissionRequest());
    persistent.controller.select(1);
    persistent.controller.confirm();
    await expect(persistentResponse).resolves.toEqual({
      decision: "allow",
      reason: "User persistently approved the policy.",
      scope: "persistent",
    });
  });

  it("serializes domain requests through one FIFO queue", async () => {
    const { controller, states, state } = setupController();
    const permission = controller.requestPermission(1, permissionRequest());
    const trust = controller.requestHookTrust(1, hookTrustRequest());

    expect(state.current?.kind).toBe("permission");
    expect(states.filter(Boolean)).toHaveLength(1);

    controller.select(0);
    controller.confirm();
    await expect(permission).resolves.toMatchObject({ decision: "allow" });
    expect(state.current?.kind).toBe("hook-trust");

    controller.confirm();
    await expect(trust).resolves.toMatchObject({ decision: "deny" });
    expect(state.current).toBeUndefined();
  });

  it("maps Hook trust selections to once and persistent scopes", async () => {
    const once = setupController();
    const onceResponse = once.controller.requestHookTrust(1, hookTrustRequest());
    once.controller.select(1);
    once.controller.confirm();
    await expect(onceResponse).resolves.toEqual({
      decision: "allow",
      reason: "User trusted the Hook for this run.",
      scope: "once",
    });

    const persistent = setupController();
    const persistentResponse = persistent.controller.requestHookTrust(1, hookTrustRequest());
    persistent.controller.select(0);
    persistent.controller.confirm();
    await expect(persistentResponse).resolves.toEqual({
      decision: "allow",
      reason: "User persistently trusted the Hook.",
      scope: "persistent",
    });
  });

  it("times out visible interactions and then starts the next timeout", async () => {
    vi.useFakeTimers();
    try {
      const { controller, state } = setupController({ timeoutMs: 1_000 });
      const permission = controller.requestPermission(1, permissionRequest());
      const trust = controller.requestHookTrust(1, hookTrustRequest());

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(permission).resolves.toEqual({
        decision: "deny",
        reason: "User interaction timed out.",
      });
      expect(state.current?.kind).toBe("hook-trust");

      await vi.advanceTimersByTimeAsync(999);
      expect(state.current?.kind).toBe("hook-trust");

      await vi.advanceTimersByTimeAsync(1);
      await expect(trust).resolves.toEqual({
        decision: "deny",
        reason: "User interaction timed out.",
      });
      expect(state.current).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("validates MCP JSON before accepting", async () => {
    const { controller, state } = setupController();
    const response = controller.requestMcpElicitation(2, {
      message: "Provide configuration.",
      mode: "form",
      requestId: "request-1",
      server: "example",
    });

    controller.select(0);
    controller.updateDraft("[");
    expect(controller.confirm()).toBe(false);
    expect(state.current?.error).toBe("请输入有效的 JSON 对象。");
    controller.updateDraft("[]");
    expect(controller.confirm()).toBe(false);
    controller.updateDraft("null");
    expect(controller.confirm()).toBe(false);

    controller.updateDraft('{"enabled":true}');
    expect(controller.confirm()).toBe(true);
    await expect(response).resolves.toEqual({
      action: "accept",
      result: { enabled: true },
    });
  });

  it("supports option and free-text questions", async () => {
    const { controller, state } = setupController();
    const optionResponse = controller.askUser(3, {
      options: ["SQLite", "PostgreSQL"],
      question: "Choose a database.",
    });

    controller.select(1);
    controller.confirm();
    await expect(optionResponse).resolves.toEqual({
      answer: "PostgreSQL",
      selectedIndex: 1,
    });

    const textResponse = controller.askUser(3, {
      question: "Why?",
    });
    expect(controller.confirm()).toBe(false);
    expect(state.current?.error).toBe("请输入回答。");
    controller.updateDraft("It is already deployed.");
    controller.confirm();
    await expect(textResponse).resolves.toEqual({
      answer: "It is already deployed.",
    });
  });

  it("answers structured questions with automatic navigation and multi-select", async () => {
    const { controller, state } = setupController();
    const response = controller.askUser(3, {
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
          header: "检查项",
          multiSelect: true,
          options: [
            { description: "运行测试", label: "测试" },
            { description: "运行静态检查", label: "Lint" },
          ],
          question: "选择检查项。",
        },
      ],
    });

    controller.select(1);
    expect(controller.confirm()).toBe(false);
    expect(state.current).toMatchObject({
      activeQuestionIndex: 1,
      kind: "question",
      selectedIndex: 0,
      selectedIndexesByQuestion: [[1], []],
    });

    controller.toggleQuestionSelection();
    controller.select(1);
    controller.toggleQuestionSelection();
    expect(controller.confirm()).toBe(false);
    expect(state.current).toMatchObject({
      reviewActive: true,
      reviewSelectedIndex: 0,
    });
    expect(controller.confirm()).toBe(true);

    await expect(response).resolves.toEqual({
      answers: [
        {
          answers: ["SQLite"],
          questionIndex: 0,
          selectedIndexes: [1],
        },
        {
          answers: ["测试", "Lint"],
          questionIndex: 1,
          selectedIndexes: [0, 1],
        },
      ],
    });
  });

  it("returns a single structured answer without opening review", async () => {
    const { controller, state } = setupController();
    const response = controller.askUser(3, {
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

    controller.moveQuestion(1);
    expect(state.current).toMatchObject({ activeQuestionIndex: 0, reviewActive: false });
    controller.select(1);
    expect(controller.confirm()).toBe(true);

    await expect(response).resolves.toEqual({
      answers: [
        {
          answers: ["SQLite"],
          questionIndex: 0,
          selectedIndexes: [1],
        },
      ],
    });
    expect(state.current).toBeUndefined();
  });

  it("supports structured question navigation and inline custom input", async () => {
    const { controller, state } = setupController();
    const response = controller.askUser(4, {
      questions: [
        {
          header: "风格",
          multiSelect: false,
          options: [
            { description: "技术表达", label: "技术直白" },
            { description: "中文品牌", label: "中文语义" },
          ],
          question: "选择标题风格。",
        },
        {
          header: "确认",
          multiSelect: false,
          options: [
            { description: "继续执行", label: "继续" },
            { description: "停止执行", label: "停止" },
          ],
          question: "是否继续？",
        },
      ],
    });

    controller.moveQuestion(1);
    expect(state.current).toMatchObject({ activeQuestionIndex: 1 });
    controller.moveQuestion(-1);
    controller.select(2);
    expect(state.current).toMatchObject({
      activeQuestionIndex: 0,
      customInputActive: true,
      draft: "",
    });
    expect(controller.confirm()).toBe(false);
    expect(state.current?.error).toBe("请输入自定义回答。");
    controller.updateDraft("混合风格");
    controller.moveQuestion(1);
    expect(state.current).toMatchObject({
      activeQuestionIndex: 1,
      customDraftsByQuestion: ["混合风格", undefined],
      customInputActive: false,
    });
    controller.moveQuestion(-1);
    expect(state.current).toMatchObject({
      activeQuestionIndex: 0,
      customInputActive: true,
      draft: "混合风格",
    });
    expect(controller.exitQuestionCustomInput()).toBe(true);
    expect(state.current).toMatchObject({
      customInputActive: false,
      draft: "",
      selectedIndex: 1,
    });
    controller.select(2);
    expect(state.current).toMatchObject({ customInputActive: true });
    controller.updateDraft("混合风格");
    expect(controller.confirm()).toBe(false);
    expect(state.current).toMatchObject({ activeQuestionIndex: 1 });
    controller.select(0);
    expect(controller.confirm()).toBe(false);
    expect(state.current).toMatchObject({ reviewActive: true });
    expect(controller.confirm()).toBe(true);

    await expect(response).resolves.toEqual({
      answers: [
        {
          answers: ["混合风格"],
          questionIndex: 0,
          selectedIndexes: [],
        },
        {
          answers: ["继续"],
          questionIndex: 1,
          selectedIndexes: [0],
        },
      ],
    });
  });

  it("keeps structured controls bounded and combines multi-select with custom input", async () => {
    const { controller, state } = setupController();
    controller.moveQuestion(1);
    controller.toggleQuestionSelection();
    expect(controller.exitQuestionCustomInput()).toBe(false);
    controller.updateDraft("ignored");

    const permission = controller.requestPermission(5, permissionRequest());
    controller.moveQuestion(1);
    controller.toggleQuestionSelection();
    expect(controller.exitQuestionCustomInput()).toBe(false);
    controller.updateDraft("ignored");
    controller.cancelCurrent();
    await expect(permission).resolves.toMatchObject({ decision: "deny" });

    const response = controller.askUser(5, {
      questions: [
        {
          header: "检查项",
          multiSelect: true,
          options: [
            { description: "运行测试", label: "测试" },
            { description: "运行静态检查", label: "Lint" },
          ],
          question: "选择检查项。",
        },
      ],
    });
    controller.moveQuestion(1);
    expect(state.current).toMatchObject({ reviewActive: false });
    expect(controller.confirm()).toBe(false);
    expect(state.current?.error).toBe("请至少选择一个选项。");
    controller.moveQuestion(-1);
    expect(state.current).toMatchObject({ reviewActive: false });
    expect(controller.confirm()).toBe(false);
    expect(state.current?.error).toBe("请至少选择一个选项。");

    controller.toggleQuestionSelection();
    controller.toggleQuestionSelection();
    controller.toggleQuestionSelection();
    controller.select(2);
    controller.updateDraft("端到端检查");
    controller.select(1);
    expect(state.current).toMatchObject({
      customDraftsByQuestion: ["端到端检查"],
      customInputActive: false,
    });
    controller.select(2);
    expect(state.current).toMatchObject({
      customInputActive: true,
      draft: "端到端检查",
    });
    expect(controller.confirm()).toBe(true);

    await expect(response).resolves.toEqual({
      answers: [
        {
          answers: ["测试", "端到端检查"],
          questionIndex: 0,
          selectedIndexes: [0],
        },
      ],
    });
  });

  it("accepts MCP URLs and maps resume retry selections", async () => {
    const { controller } = setupController();
    const mcp = controller.requestMcpElicitation(4, {
      message: "Open authorization.",
      mode: "url",
      requestId: "request-url",
      server: "example",
      url: "https://example.test/authorize",
    });

    controller.select(0);
    controller.confirm();
    await expect(mcp).resolves.toEqual({ action: "accept" });

    const resume = controller.requestResumeReview(4, resumeReviewRequest());
    controller.select(1);
    controller.confirm();
    await expect(resume).resolves.toEqual({ action: "retry" });
  });

  it("declines MCP Elicitation by default", async () => {
    const { controller } = setupController();
    const response = controller.requestMcpElicitation(5, {
      message: "Provide configuration.",
      mode: "form",
      requestId: "request-default",
      server: "example",
    });

    controller.confirm();
    await expect(response).resolves.toEqual({ action: "decline" });
  });

  it("keeps inactive operations idempotent and uses default cancellation", async () => {
    const { controller, state } = setupController();

    controller.select(1);
    controller.updateDraft("ignored");
    controller.cancelRun(99);
    controller.cancelAll();
    expect(controller.confirm()).toBe(false);
    expect(controller.cancelCurrent()).toBe(false);
    expect(controller.isPending()).toBe(false);

    const workspace = controller.requestWorkspaceAccess("/workspace");
    expect(controller.isPending()).toBe(true);
    expect(controller.cancelCurrent()).toBe(true);
    await expect(workspace).resolves.toEqual({ action: "exit" });
    expect(state.current).toBeUndefined();
  });

  it("cancels only interactions owned by one run", async () => {
    const { controller, state } = setupController();
    const first = controller.requestPermission(10, permissionRequest());
    const nextRun = controller.requestPermission(20, permissionRequest());
    const question = controller.askUser(10, { question: "Continue?" });

    controller.cancelRun(10, "Run canceled.");

    await expect(first).resolves.toEqual({
      decision: "deny",
      reason: "Run canceled.",
    });
    await expect(question).rejects.toEqual(
      expect.objectContaining({
        message: "Run canceled.",
        name: "UserInteractionCanceledError",
      }),
    );
    expect(state.current).toMatchObject({ kind: "permission", runId: 20 });

    controller.confirm();
    await expect(nextRun).resolves.toMatchObject({ decision: "deny" });
  });

  it("maps cancellation for every domain and clears the queue", async () => {
    const { controller, state } = setupController();
    const permission = controller.requestPermission(1, permissionRequest());
    const trust = controller.requestHookTrust(1, hookTrustRequest());
    const mcp = controller.requestMcpElicitation(1, {
      message: "Authorize.",
      requestId: "request-2",
      server: "example",
    });
    const resume = controller.requestResumeReview(1, resumeReviewRequest());

    controller.cancelAll("CLI closed.");

    await expect(permission).resolves.toEqual({ decision: "deny", reason: "CLI closed." });
    await expect(trust).resolves.toEqual({ decision: "deny", reason: "CLI closed." });
    await expect(mcp).resolves.toEqual({ action: "decline" });
    await expect(resume).resolves.toEqual({ action: "abandon" });
    expect(controller.isPending()).toBe(false);
    expect(state.current).toBeUndefined();
  });

  it("uses a stable cancellation error for user questions", async () => {
    const { controller } = setupController();
    const response = controller.askUser(1, { question: "Continue?" });

    expect(controller.cancelCurrent("Question canceled.")).toBe(true);
    await expect(response).rejects.toBeInstanceOf(UserInteractionCanceledError);
    expect(controller.cancelCurrent()).toBe(false);
  });

  it("cancels a structured question from the review page", async () => {
    const { controller, state } = setupController();
    const response = controller.askUser(1, {
      questions: [
        {
          header: "确认",
          multiSelect: false,
          options: [
            { description: "继续执行", label: "继续" },
            { description: "停止执行", label: "停止" },
          ],
          question: "是否继续？",
        },
        {
          header: "方式",
          multiSelect: false,
          options: [
            { description: "立即执行", label: "立即" },
            { description: "稍后执行", label: "稍后" },
          ],
          question: "何时执行？",
        },
      ],
    });

    controller.moveQuestion(2);
    controller.select(1);
    expect(state.current).toMatchObject({
      reviewActive: true,
      reviewSelectedIndex: 1,
    });
    expect(controller.confirm()).toBe(true);
    await expect(response).rejects.toMatchObject({
      message: "User canceled the question review.",
      name: "UserInteractionCanceledError",
    });
  });

  it("validates the interaction timeout configuration", () => {
    expect(() => setupController({ timeoutMs: 0 })).toThrow(
      "User interaction timeout must be a positive integer.",
    );
  });
});

function setupController(options: { readonly timeoutMs?: number | undefined } = {}) {
  const states: Array<UserInteractionState | undefined> = [];
  const state: { current: UserInteractionState | undefined } = {
    current: undefined,
  };
  const onStateChange = vi.fn((next: UserInteractionState | undefined) => {
    state.current = next;
    states.push(next);
  });

  return {
    controller: new UserInteractionController({ ...options, onStateChange }),
    onStateChange,
    state,
    states,
  };
}

function permissionRequest(): PermissionRequest {
  return {
    action: "execute command",
    capabilities: ["process.execute", "workspace.delete"],
    normalizedAction: "recursively remove workspace files",
    policyId: "recursive-force-rm",
    reason: "destructive command",
    risk: "high",
    subject: "rm -rf build",
    toolName: "bashTool",
    workspaceId: "workspace-1",
  };
}

function hookTrustRequest(): HookTrustRequest {
  return {
    capability: "node hook.mjs",
    eventName: "UserPromptSubmit",
    executorType: "command",
    handlerHash: "1234567890abcdef",
    hookId: "hook-1",
    opaque: false,
    source: {
      path: "/workspace/.yiku/settings.json",
      type: "project",
    },
    trustKey: "trust-key-1234567890",
  };
}

function resumeReviewRequest(): SessionResumeReviewRequest {
  return {
    operation: {
      callId: "call-1",
      effect: "write",
      inputSummary: "edit file",
      stageId: "stage-1",
      startedAt: "2026-08-01T00:00:00.000Z",
      toolName: "textEditorTool",
    },
  };
}
