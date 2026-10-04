import { describe, expect, it, vi } from "vitest";
import { askUserTool } from "../../../src/tools/user-question/tool.js";
import {
  normalizeUserQuestionRequest,
  parseUserQuestionInput,
  userQuestionInputSchema,
} from "../../../src/tools/user-question/types.js";

describe("askUserTool", () => {
  it("exposes only the canonical structured schema to the model", () => {
    const tool = askUserTool();
    const parameters = tool.parameters as {
      readonly properties: Readonly<Record<string, unknown>>;
      readonly required: readonly string[];
    };

    expect(Object.keys(parameters.properties)).toEqual(["questions"]);
    expect(parameters.required).toEqual(["questions"]);
    const questions = parameters.properties.questions as {
      readonly items: {
        readonly properties: {
          readonly options: {
            readonly items: { readonly required: readonly string[] };
          };
        };
        readonly required: readonly string[];
      };
    };
    expect(questions.items.required).toEqual([
      "allowAutoRecommended",
      "header",
      "multiSelect",
      "options",
      "preconfiguredAnswer",
      "question",
      "questionKey",
      "risk",
    ]);
    expect(questions.items.properties.options.items.required).toEqual([
      "description",
      "label",
      "optionId",
      "recommended",
    ]);
  });

  it("returns a free-text answer from the host handler", async () => {
    const handler = vi.fn(async () => ({ answer: "Use SQLite." }));
    const tool = askUserTool({ handler });

    expect(tool.name).toBe("AskUserQuestion");
    await expect(
      tool.invoke({} as never, JSON.stringify({ question: "Which database should we use?" })),
    ).resolves.toBe('{"answer":"Use SQLite."}');
    expect(handler).toHaveBeenCalledWith({
      question: "Which database should we use?",
    });
  });

  it("returns a selected option", async () => {
    const handler = vi.fn(async () => ({ answer: "Read-only", selectedIndex: 0 }));
    const tool = askUserTool({ handler });

    await expect(
      tool.invoke(
        {} as never,
        JSON.stringify({
          options: ["Read-only", "Read-write"],
          question: "Choose access.",
        }),
      ),
    ).resolves.toBe('{"answer":"Read-only","selectedIndex":0}');
  });

  it("infers the selected index from an option answer", async () => {
    const tool = askUserTool({
      description: "Choose one option.",
      handler: async () => ({ answer: "Read-write" }),
      name: "chooseAccessTool",
    });

    expect(tool.name).toBe("chooseAccessTool");
    expect(tool.description).toBe("Choose one option.");
    await expect(
      tool.invoke(
        {} as never,
        JSON.stringify({
          options: ["Read-only", "Read-write"],
          question: "Choose access.",
        }),
      ),
    ).resolves.toBe('{"answer":"Read-write","selectedIndex":1}');
  });

  it("returns structured answers for multiple questions", async () => {
    const input = {
      questions: [
        {
          header: "数据库",
          multiSelect: false,
          options: [
            { description: "生产数据库", label: "PostgreSQL" },
            { description: "本地轻量数据库", label: "SQLite" },
          ],
          question: "选择数据库。",
        },
        {
          header: "检查项",
          multiSelect: true,
          options: [
            { description: "执行单元测试", label: "测试" },
            { description: "执行静态检查", label: "Lint" },
          ],
          question: "选择需要执行的检查。",
        },
      ],
    };
    const response = {
      answers: [
        {
          answers: ["SQLite"],
          questionIndex: 0,
          selectedIndexes: [1],
        },
        {
          answers: ["测试", "运行端到端检查"],
          questionIndex: 1,
          selectedIndexes: [0],
        },
      ],
    };
    const handler = vi.fn(async () => response);
    const tool = askUserTool({ handler });

    await expect(tool.invoke({} as never, JSON.stringify(input))).resolves.toBe(
      JSON.stringify(response),
    );
    expect(handler).toHaveBeenCalledWith(input);
  });

  it("prefers structured questions when strict providers also populate legacy fields", async () => {
    const questions = [
      {
        header: "标题风格选择",
        multiSelect: false,
        options: [
          { description: "简洁干净，适合作为基础模板", label: "极简风格" },
          { description: "突出技术栈和工程属性", label: "技术品牌感" },
          { description: "使用有质感的产品名称", label: "产品化命名" },
          { description: "使用活泼而有个性的名称", label: "创意有趣" },
        ],
        question: "你想要什么风格的页面标题？",
      },
    ];
    const response = {
      answers: [
        {
          answers: ["极简风格"],
          questionIndex: 0,
          selectedIndexes: [0],
        },
      ],
    };
    const handler = vi.fn(async () => response);
    const tool = askUserTool({ handler });

    await expect(
      tool.invoke(
        {} as never,
        JSON.stringify({
          options: ["极简风格", "技术品牌感", "产品化命名", "创意有趣"],
          question: "你想要什么风格的标题？",
          questions,
        }),
      ),
    ).resolves.toBe(JSON.stringify(response));
    expect(handler).toHaveBeenCalledWith({ questions });
  });

  it("falls back to a valid legacy request when questions is empty", () => {
    expect(
      parseUserQuestionInput({
        options: ["PostgreSQL", "SQLite"],
        question: "Choose a database.",
        questions: [],
      }),
    ).toEqual({
      options: ["PostgreSQL", "SQLite"],
      question: "Choose a database.",
    });
  });

  it("reports invalid business input without a JSON parsing error", async () => {
    const tool = askUserTool({ handler: async () => ({ answer: "unused" }) });
    const emptyOutput = await tool.invoke({} as never, JSON.stringify({ questions: [] }));
    const nullOutput = await tool.invoke(
      {} as never,
      JSON.stringify({ options: [], question: "null", questions: [] }),
    );

    expect(emptyOutput).toContain("Provide either question or questions, but not both.");
    expect(nullOutput).toContain("Legacy options require question.");
    expect(emptyOutput).not.toContain("Invalid JSON input for tool");
    expect(nullOutput).not.toContain("Invalid JSON input for tool");
  });

  it("normalizes old and structured requests for CLI presentation", () => {
    expect(
      normalizeUserQuestionRequest({
        options: ["SQLite", "PostgreSQL"],
        question: "Choose.",
      }),
    ).toEqual({
      questions: [
        {
          allowAutoRecommended: false,
          allowCustom: false,
          freeText: false,
          header: "问题",
          multiSelect: false,
          options: [
            { description: "", label: "SQLite" },
            { description: "", label: "PostgreSQL" },
          ],
          preconfiguredAnswer: false,
          question: "Choose.",
          risk: "required-input",
        },
      ],
      source: "legacy",
    });
    expect(
      normalizeUserQuestionRequest({
        description: "Configure a subagent.",
        questions: [
          {
            header: "Storage",
            multiSelect: false,
            options: [
              { description: "Local", label: "SQLite" },
              { description: "Remote", label: "PostgreSQL" },
            ],
            question: "Choose.",
          },
        ],
        title: "Agent profile",
      }),
    ).toEqual({
      description: "Configure a subagent.",
      questions: [
        {
          allowAutoRecommended: false,
          allowCustom: true,
          freeText: false,
          header: "Storage",
          multiSelect: false,
          options: [
            { description: "Local", label: "SQLite" },
            { description: "Remote", label: "PostgreSQL" },
          ],
          preconfiguredAnswer: false,
          question: "Choose.",
          risk: "required-input",
        },
      ],
      source: "structured",
      title: "Agent profile",
    });
  });

  it("normalizes stable non-interactive question metadata", () => {
    expect(
      normalizeUserQuestionRequest({
        questions: [
          {
            allowAutoRecommended: true,
            header: "Storage",
            multiSelect: false,
            options: [
              {
                description: "Local",
                label: "SQLite",
                optionId: "sqlite",
                recommended: true,
              },
              {
                description: "Remote",
                label: "PostgreSQL",
                optionId: "postgresql",
              },
            ],
            question: "Choose.",
            questionKey: "code.storage.database@1",
            risk: "preference",
          },
        ],
      }),
    ).toMatchObject({
      questions: [
        {
          allowAutoRecommended: true,
          options: [{ optionId: "sqlite", recommended: true }, { optionId: "postgresql" }],
          preconfiguredAnswer: false,
          questionKey: "code.storage.database@1",
          risk: "preference",
        },
      ],
    });

    expect(() =>
      userQuestionInputSchema.parse({
        questions: [
          {
            header: "Storage",
            multiSelect: false,
            options: [
              { description: "Local", label: "SQLite", optionId: "same" },
              { description: "Remote", label: "PostgreSQL", optionId: "same" },
            ],
            question: "Choose.",
            questionKey: "INVALID",
          },
        ],
      }),
    ).toThrow();
  });

  it.each([
    {
      input: { question: "Continue?" },
      message: "User question answer must be non-empty.",
      response: { answer: " " },
    },
    {
      input: { question: "Continue?" },
      message: "Free-text answers cannot include a selected option.",
      response: { answer: "Yes", selectedIndex: 0 },
    },
    {
      input: { options: ["Yes", "No"], question: "Continue?" },
      message: "User question response must select one of the provided options.",
      response: { answer: "Maybe", selectedIndex: 3 },
    },
    {
      input: { options: ["Yes", "No"], question: "Continue?" },
      message: "User question answer does not match the selected option.",
      response: { answer: "No", selectedIndex: 0 },
    },
  ])("rejects an invalid host response: $message", async ({ input, message, response }) => {
    const tool = askUserTool({
      handler: async () => response,
    });

    await expect(tool.invoke({} as never, JSON.stringify(input))).resolves.toBe(
      `Error: ${message}`,
    );
  });

  it("rejects duplicate options", () => {
    expect(() =>
      userQuestionInputSchema.parse({
        options: ["Same", "Same"],
        question: "Choose.",
      }),
    ).toThrow("Question options must be unique.");
  });

  it("rejects invalid structured questions and responses", async () => {
    expect(() =>
      userQuestionInputSchema.parse({
        questions: [
          {
            header: "Duplicate",
            multiSelect: false,
            options: [
              { description: "First", label: "Same" },
              { description: "Second", label: "Same" },
            ],
            question: "Choose.",
          },
        ],
      }),
    ).toThrow("Question option labels must be unique.");

    const tool = askUserTool({
      handler: async () => ({
        answers: [
          {
            answers: ["SQLite", "PostgreSQL"],
            questionIndex: 0,
            selectedIndexes: [0, 1],
          },
        ],
      }),
    });
    await expect(
      tool.invoke(
        {} as never,
        JSON.stringify({
          questions: [
            {
              header: "Storage",
              multiSelect: false,
              options: [
                { description: "Local", label: "SQLite" },
                { description: "Remote", label: "PostgreSQL" },
              ],
              question: "Choose.",
            },
          ],
        }),
      ),
    ).resolves.toBe("Error: Single-select questions require exactly one answer.");
  });

  it("fails closed without a host handler", async () => {
    const tool = askUserTool();

    await expect(tool.invoke({} as never, JSON.stringify({ question: "Continue?" }))).resolves.toBe(
      "Error: User question handler is not configured.",
    );
  });
});
