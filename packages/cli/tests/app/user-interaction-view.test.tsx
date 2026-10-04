import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import {
  UserInteractionController,
  type UserInteractionState,
} from "../../src/app/user-interaction.js";
import { customAnswerDisplay, UserInteractionView } from "../../src/app/user-interaction-view.js";

describe("UserInteractionView", () => {
  it("models the three inline custom input states", () => {
    expect(customAnswerDisplay(false, "")).toEqual({
      cursor: "none",
      text: "Type something.",
      tone: "placeholder",
    });
    expect(customAnswerDisplay(true, "")).toEqual({
      cursor: "first-character",
      remainder: "ype something.",
    });
    expect(customAnswerDisplay(true, "测试")).toEqual({
      cursor: "after-value",
      text: "测试",
    });
  });

  it("renders and confirms workspace access with shared keyboard handling", async () => {
    const fixture = interactionFixture();
    const response = fixture.controller.requestWorkspaceAccess("/workspace/project");
    const app = render(
      <UserInteractionView controller={fixture.controller} state={fixture.requireState()} />,
    );

    expect(app.lastFrame()).toContain("授权当前工作区");
    expect(app.lastFrame()).toContain("/workspace/project");
    expect(app.lastFrame()).toMatch(/● 仅本次读写[\s\S]*○ 长期读写[\s\S]*○ 拒绝授权/u);
    app.stdin.write("\r");

    await expect(response).resolves.toEqual({
      accessMode: "read-write",
      action: "allow",
      persistence: "session",
    });
    app.unmount();
  });

  it("renders the Workspace write upgrade choices", async () => {
    const fixture = interactionFixture();
    const response = fixture.controller.requestWorkspaceWriteAccess(1, {
      action: "edit",
      subject: "src/index.ts",
      workspaceId: "workspace-1",
    });
    const app = render(
      <UserInteractionView controller={fixture.controller} state={fixture.requireState()} />,
    );

    expect(app.lastFrame()).toContain("编辑需要工作区写权限");
    expect(app.lastFrame()).toContain("升级本次会话为读写");
    expect(app.lastFrame()).toContain("长期授予读写");
    app.stdin.write("\r");
    await expect(response).resolves.toEqual({
      decision: "allow",
      persistence: "session",
    });
    app.unmount();
  });

  it("collects a free-text answer", async () => {
    const fixture = interactionFixture();
    const response = fixture.controller.askUser(1, {
      question: "Which database should we use?",
    });
    const app = render(
      <UserInteractionView controller={fixture.controller} state={fixture.requireState()} />,
    );

    expect(app.lastFrame()).toContain("Which database should we use?");
    app.stdin.write("SQLite");
    app.stdin.write("\r");

    await expect(response).resolves.toEqual({ answer: "SQLite" });
    app.unmount();
  });

  it("renders MCP schema, draft, and choices", () => {
    const fixture = interactionFixture();
    void fixture.controller.requestMcpElicitation(1, {
      message: "Choose a mode.",
      mode: "form",
      requestId: "request-1",
      requestedSchema: {
        properties: {
          mode: { type: "string" },
        },
        type: "object",
      },
      server: "policy",
    });
    fixture.controller.updateDraft('{"mode":"strict"}');
    const app = render(
      <UserInteractionView controller={fixture.controller} state={fixture.requireState()} />,
    );
    const frame = app.lastFrame() ?? "";

    expect(frame).toContain("MCP 请求用户输入");
    expect(frame).toContain("policy");
    expect(frame).toContain("Choose a mode.");
    expect(frame).toContain('{"mode":"strict"}');
    app.unmount();
    fixture.controller.cancelAll();
  });

  it("renders specialized domain variants through one view", () => {
    const permission = interactionFixture();
    void permission.controller.requestPermission(1, {
      action: "invoke MCP tool",
      capabilities: ["external.mcp.invoke"],
      normalizedAction: "invoke external MCP tool",
      policyId: "mcp-external-side-effect",
      reason: "external side effects",
      risk: "high",
      subject: "github/create_issue",
      toolName: "github/create_issue",
      workspaceId: "workspace-1",
    });
    const permissionApp = render(
      <UserInteractionView controller={permission.controller} state={permission.requireState()} />,
    );
    expect(permissionApp.lastFrame()).toContain("MCP 工具需要授权");
    expect(permissionApp.lastFrame()).toContain("本次会话允许此权限");
    expect(permissionApp.lastFrame()).toContain("操作目的：invoke external MCP tool");
    expect(permissionApp.lastFrame()).toContain("风险原因：external side effects");
    permissionApp.unmount();
    permission.controller.cancelAll();

    const trust = interactionFixture();
    void trust.controller.requestHookTrust(1, {
      capability: "node hook.mjs",
      eventName: "UserPromptSubmit",
      executorType: "command",
      handlerHash: "abcdef0123456789",
      hookId: "hook-1",
      opaque: true,
      source: { type: "managed" },
      trustKey: "trust-key-123456789",
    });
    const trustApp = render(
      <UserInteractionView controller={trust.controller} state={trust.requireState()} />,
    );
    expect(trustApp.lastFrame()).toContain("Yiku Hook 需要信任");
    expect(trustApp.lastFrame()).toContain("Hook：hook-1");
    expect(trustApp.lastFrame()).toContain("触发：UserPromptSubmit");
    expect(trustApp.lastFrame()).toContain("不代表当前 Agent 正在执行上述命令");
    expect(trustApp.lastFrame()).toContain("opaque shell：是");
    expect(trustApp.lastFrame()).toMatch(
      /○ 持久信任并执行[\s\S]*\n[\s\S]*○ 仅本次信任并执行[\s\S]*\n[\s\S]*● 拒绝信任/u,
    );
    trustApp.unmount();
    trust.controller.cancelAll();

    const transparentTrust = interactionFixture();
    void transparentTrust.controller.requestHookTrust(1, {
      capability: "node safe-hook.mjs",
      executorType: "command",
      handlerHash: "1234567890abcdef",
      hookId: "hook-2",
      opaque: false,
      source: { path: "/workspace/hook.json", type: "project" },
      trustKey: "trust-key-transparent",
    });
    const transparentTrustApp = render(
      <UserInteractionView
        controller={transparentTrust.controller}
        state={transparentTrust.requireState()}
      />,
    );
    expect(transparentTrustApp.lastFrame()).toContain("opaque shell：否");
    transparentTrustApp.unmount();
    transparentTrust.controller.cancelAll();

    const resume = interactionFixture();
    void resume.controller.requestResumeReview(1, {
      operation: {
        callId: "call-1",
        effect: "write",
        inputSummary: "edit file",
        stageId: "stage-1",
        startedAt: "2026-08-01T00:00:00.000Z",
        toolName: "textEditorTool",
      },
    });
    const resumeApp = render(
      <UserInteractionView controller={resume.controller} state={resume.requireState()} />,
    );
    expect(resumeApp.lastFrame()).toContain("检测到结果未知的副作用");
    resumeApp.unmount();
    resume.controller.cancelAll();

    const question = interactionFixture();
    const questionResponse = question.controller.askUser(1, {
      options: ["SQLite", "PostgreSQL"],
      question: "Choose a database.",
    });
    const questionApp = render(
      <UserInteractionView controller={question.controller} state={question.requireState()} />,
    );
    expect(questionApp.lastFrame()).toContain("› 1. SQLite");
    expect(questionApp.lastFrame()).toContain("2. PostgreSQL");
    question.controller.cancelAll();
    questionApp.unmount();
    return expect(questionResponse).rejects.toThrow("CLI exited");
  });

  it("renders the structured reference-style question form", async () => {
    const fixture = interactionFixture();
    const response = fixture.controller.askUser(1, {
      description: "我需要先了解你想创建的 subagent 需求。",
      questions: [
        {
          header: "标题风格",
          multiSelect: false,
          options: [
            { description: "Accumulator & RNG", label: "技术直白" },
            { description: "原子流演示", label: "中文语义" },
          ],
          question: "想把 header 标题换成哪种风格？",
        },
        {
          header: "检查项",
          multiSelect: true,
          options: [
            { description: "运行单元测试", label: "测试" },
            { description: "运行静态检查", label: "Lint" },
          ],
          question: "选择检查项。",
        },
      ],
      title: "AskUserQuestion(标题风格，检查项)",
    });
    const app = render(
      <UserInteractionView controller={fixture.controller} state={fixture.requireState()} />,
    );
    const frame = app.lastFrame() ?? "";

    expect(frame).toContain("想把 header 标题换成哪种风格？");
    expect(frame).toContain("● 我需要先了解你想创建的 subagent 需求。");
    expect(frame).toContain("● AskUserQuestion(标题风格，检查项)");
    expect(frame).toContain("←");
    expect(frame).toContain("□ 标题风格");
    expect(frame).toContain("□ 检查项");
    expect(frame).toContain("✓ Submit");
    expect(frame).toContain("→");
    expect(frame).toContain("› 1. 技术直白");
    expect(frame).toContain("Accumulator & RNG");
    expect(frame).toContain("2. 中文语义");
    expect(frame).toContain("3. Type something.");
    expect(frame).not.toContain("[ Type something. ]");
    expect(frame).toContain("↑↓ to select · ←→/Tab to change question");
    app.unmount();
    fixture.controller.cancelAll();
    await expect(response).rejects.toThrow("CLI exited");
  });

  it("omits submit navigation for one structured question", async () => {
    const fixture = interactionFixture();
    const response = fixture.controller.askUser(1, {
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
    const app = render(
      <UserInteractionView controller={fixture.controller} state={fixture.requireState()} />,
    );
    const frame = app.lastFrame() ?? "";

    expect(frame).toContain("数据库");
    expect(frame).not.toContain("Submit");
    expect(frame).not.toContain("←→/Tab to change question");
    app.stdin.write("\u001B[B");
    app.stdin.write("\r");

    await expect(response).resolves.toEqual({
      answers: [
        {
          answers: ["SQLite"],
          questionIndex: 0,
          selectedIndexes: [1],
        },
      ],
    });
    app.unmount();
  });

  it("handles structured keyboard states and inline custom input errors", async () => {
    const fixture = interactionFixture();
    const response = fixture.controller.askUser(1, {
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
    const app = render(
      <UserInteractionView controller={fixture.controller} state={fixture.requireState()} />,
    );
    const rerender = () =>
      app.rerender(
        <UserInteractionView controller={fixture.controller} state={fixture.requireState()} />,
      );

    app.stdin.write("\t");
    rerender();
    expect(app.lastFrame()).toContain("Space to toggle");
    app.stdin.write("\u001B[Z");
    await vi.waitFor(() => {
      expect(fixture.requireState()).toMatchObject({ activeQuestionIndex: 0 });
    });
    rerender();
    app.stdin.write("\t");
    rerender();
    app.stdin.write("\u001B[D");
    rerender();
    expect(fixture.requireState()).toMatchObject({ activeQuestionIndex: 0 });
    app.stdin.write("\u001B[C");
    rerender();
    expect(fixture.requireState()).toMatchObject({ activeQuestionIndex: 1 });

    app.stdin.write(" ");
    rerender();
    expect(app.lastFrame()).toContain("[x] 测试");
    app.stdin.write("\u001B[B");
    rerender();
    app.stdin.write("\u001B[B");
    rerender();
    expect(app.lastFrame()).toContain("› 3. Type something.");
    expect(app.lastFrame()).not.toContain("[ Type something. ]");
    expect(app.lastFrame()).not.toContain("|");
    expect(app.lastFrame()).not.toContain("自定义回答：");
    expect(app.lastFrame()).toContain("Esc to go back");
    app.stdin.write("\u001B[A");
    expect(fixture.requireState()).toMatchObject({
      customInputActive: false,
      selectedIndex: 1,
    });
    rerender();
    app.stdin.write("\u001B[B");
    expect(fixture.requireState()).toMatchObject({
      customInputActive: true,
      selectedIndex: 2,
    });
    rerender();
    app.stdin.write("\r");
    rerender();
    expect(app.lastFrame()).toContain("请输入自定义回答。");

    app.stdin.write("custom");
    rerender();
    expect(app.lastFrame()).toContain("› 3. custom");
    app.stdin.write("\u001B[A");
    expect(fixture.requireState()).toMatchObject({
      customDraftsByQuestion: [undefined, "custom"],
      customInputActive: false,
      selectedIndex: 1,
    });
    rerender();
    app.stdin.write("\u001B[B");
    expect(fixture.requireState()).toMatchObject({
      customInputActive: true,
      draft: "custom",
      selectedIndex: 2,
    });
    rerender();
    app.stdin.write("\u007F");
    rerender();
    app.stdin.write("\u0015");
    rerender();
    expect(fixture.requireState()).toMatchObject({ draft: "" });
    app.stdin.write("\u001B");
    await vi.waitFor(() => {
      expect(fixture.requireState()).toMatchObject({ customInputActive: false });
    });
    rerender();

    fixture.controller.cancelAll();
    await expect(response).rejects.toThrow("CLI exited");
    app.unmount();
  });

  it("reviews structured answers before submitting", async () => {
    const fixture = interactionFixture();
    const response = fixture.controller.askUser(1, {
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
          header: "运行方式",
          multiSelect: false,
          options: [
            { description: "立即运行", label: "现在" },
            { description: "稍后运行", label: "稍后" },
          ],
          question: "何时运行？",
        },
      ],
    });
    const app = render(
      <UserInteractionView controller={fixture.controller} state={fixture.requireState()} />,
    );
    const rerender = () =>
      app.rerender(
        <UserInteractionView controller={fixture.controller} state={fixture.requireState()} />,
      );

    app.stdin.write("\u001B[C");
    rerender();
    app.stdin.write("\u001B[C");
    rerender();
    expect(app.lastFrame()).toContain("Review your answers");
    expect(app.lastFrame()).toContain("⚠ You have not answered all questions");
    expect(app.lastFrame()).toContain("Not answered");
    app.stdin.write("\r");
    rerender();
    expect(app.lastFrame()).toContain("请先回答所有问题。");

    app.stdin.write("\u001B[D");
    rerender();
    app.stdin.write("\r");
    rerender();
    app.stdin.write("\r");
    rerender();
    expect(app.lastFrame()).toContain("Review your answers");
    expect(app.lastFrame()).not.toContain("⚠ You have not answered all questions");
    expect(app.lastFrame()).toContain("数据库: PostgreSQL");
    expect(app.lastFrame()).toContain("运行方式: 现在");
    app.stdin.write("\r");

    await expect(response).resolves.toEqual({
      answers: [
        {
          answers: ["PostgreSQL"],
          questionIndex: 0,
          selectedIndexes: [0],
        },
        {
          answers: ["现在"],
          questionIndex: 1,
          selectedIndexes: [0],
        },
      ],
    });
    app.unmount();
  });

  it("renders URL Elicitation and clears a text draft", async () => {
    const url = interactionFixture();
    void url.controller.requestMcpElicitation(1, {
      message: "Authorize access.",
      mode: "url",
      requestId: "request-url",
      server: "policy",
      url: "https://example.test/authorize",
    });
    const urlApp = render(
      <UserInteractionView controller={url.controller} state={url.requireState()} />,
    );
    expect(urlApp.lastFrame()).toContain("https://example.test/authorize");
    expect(urlApp.lastFrame()).not.toContain("响应：");
    urlApp.unmount();
    url.controller.cancelAll();

    const text = interactionFixture();
    const response = text.controller.askUser(1, { question: "Why?" });
    text.controller.updateDraft("temporary");
    const textApp = render(
      <UserInteractionView controller={text.controller} state={text.requireState()} />,
    );
    textApp.stdin.write("\u0015");
    expect(text.requireState()).toMatchObject({ draft: "" });
    text.controller.cancelAll();
    textApp.unmount();
    await expect(response).rejects.toThrow("CLI exited");

    const longText = interactionFixture();
    const longResponse = longText.controller.askUser(1, { question: "Explain." });
    longText.controller.updateDraft("x".repeat(2_100));
    const longTextApp = render(
      <UserInteractionView controller={longText.controller} state={longText.requireState()} />,
    );
    const longFrame = (longTextApp.lastFrame() ?? "").replace(/[\s│╭╮╰╯─]/gu, "");
    expect(longFrame).toContain(`${"x".repeat(2_000)}...`);
    expect(longFrame).not.toContain("x".repeat(2_001));
    longTextApp.stdin.write("\u001B[D");
    longTextApp.stdin.write("\u0001");
    longText.controller.cancelAll();
    longTextApp.unmount();
    await expect(longResponse).rejects.toThrow("CLI exited");
  });
});

function interactionFixture() {
  let state: UserInteractionState | undefined;
  const controller = new UserInteractionController({
    onStateChange: (next) => {
      state = next;
    },
  });

  return {
    controller,
    requireState: () => {
      if (state === undefined) {
        throw new Error("Expected an active user interaction.");
      }
      return state;
    },
  };
}
