import { describe, expect, it, vi } from "vitest";
import {
  applySlashCommandCompletion,
  createSlashCommands,
  getSlashCommandGroup,
  getSlashCommandQuery,
  getSlashCommandSuggestions,
  parseSlashCommandArguments,
  resolveSlashCommand,
} from "../../src/slash-commands/registry.js";
import type { InteractiveSlashCommand } from "../../src/slash-commands/types.js";

describe("slash command completion", () => {
  it("detects slash tokens at the start or after whitespace", () => {
    expect(getSlashCommandQuery("/he", 3)).toEqual({
      endIndex: 3,
      query: "he",
      startIndex: 0,
    });
    expect(getSlashCommandQuery("请执行 /he 后继续", 7)).toEqual({
      endIndex: 7,
      query: "he",
      startIndex: 4,
    });
  });

  it("ignores slashes attached to another token", () => {
    expect(getSlashCommandQuery("path/help", 9)).toBeUndefined();
    expect(getSlashCommandQuery("https://example.test", 8)).toBeUndefined();
  });

  it("replaces the complete token and preserves surrounding input", () => {
    const input = "请执行 /he 后继续";
    const completion = getSlashCommandQuery(input, 6);

    if (!completion) {
      throw new Error("Expected slash completion query.");
    }

    expect(applySlashCommandCompletion(input, completion, "help")).toEqual({
      cursorIndex: 9,
      value: "请执行 /help 后继续",
    });
  });

  it("adds a trailing space when completing at the end of input", () => {
    const completion = getSlashCommandQuery("/cl", 3);

    if (!completion) {
      throw new Error("Expected slash completion query.");
    }

    expect(applySlashCommandCompletion("/cl", completion, "clear")).toEqual({
      cursorIndex: 7,
      value: "/clear ",
    });
  });

  it("filters suggestions using the active token at the cursor", () => {
    expect(getSlashCommandSuggestions("请执行 /he", 7).map((command) => command.name)).toEqual([
      "help",
    ]);
    expect(getSlashCommandSuggestions("plain text", 10)).toEqual([]);
  });

  it("sorts matching commands into the same logical groups used by the menu", () => {
    const commands = createSlashCommands([{ name: "code-review" }]);
    const suggestions = getSlashCommandSuggestions("/co", 3, commands);

    expect(suggestions.map((command) => command.name)).toEqual([
      "copy",
      "context",
      "usage",
      "compact",
      "code-review",
    ]);
    expect(suggestions.map(getSlashCommandGroup)).toEqual([
      "SESSION",
      "STATUS",
      "STATUS",
      "RUNTIME",
      "SKILLS",
    ]);
  });
});

describe("resolveSlashCommand", () => {
  it("keeps local execution limited to a standalone slash command", () => {
    expect(resolveSlashCommand(" /help ").kind).toBe("found");
    expect(resolveSlashCommand("请执行 /help").kind).toBe("not-slash");
  });

  it("parses quoted and escaped command arguments", () => {
    expect(parseSlashCommandArguments('inspect "hook one" hook\\ two')).toEqual({
      raw: 'inspect "hook one" hook\\ two',
      values: ["inspect", "hook one", "hook two"],
    });
    expect(resolveSlashCommand("/hooks inspect hook_1")).toMatchObject({
      arguments: {
        values: ["inspect", "hook_1"],
      },
      kind: "found",
    });
    expect(resolveSlashCommand('/hooks inspect "unfinished')).toMatchObject({
      commandName: "hooks",
      kind: "invalid",
    });
    expect(parseSlashCommandArguments(`  'a"b'  ""  `)).toEqual({
      raw: `  'a"b'  ""  `,
      values: ['a"b', ""],
    });
  });

  it("registers configured Skills and resolves chained invocations", () => {
    const commands = createSlashCommands([
      { description: "Review changes", name: "skill-review" },
      { description: "Verify behavior", name: "verify" },
      { name: "help" },
      { name: "invalid/name" },
    ]);

    expect(
      getSlashCommandSuggestions("/", 1, commands).some((command) => command.source === "skill"),
    ).toBe(true);
    expect(
      getSlashCommandSuggestions("/skill-r", 8, commands).map((command) => command.name),
    ).toEqual(["skill-review"]);
    expect(
      commands.filter((command) => command.source === "skill").map((command) => command.name),
    ).toEqual(["skill-review", "verify"]);

    const resolution = resolveSlashCommand('/skill-review /verify "focus tests"', commands);
    expect(resolution).toMatchObject({
      arguments: {
        values: ["focus tests"],
      },
      command: {
        kind: "prompt",
        source: "skill",
      },
      kind: "found",
    });
    if (resolution.kind !== "found") {
      throw new Error("Expected a resolved Skill command.");
    }
    if (resolution.command.kind !== "prompt") {
      throw new Error("Expected a prompt Skill command.");
    }
    expect(resolution.command.getSubmission({} as never, resolution.arguments)).toEqual({
      activatedSkills: ["skill-review", "verify"],
      commandArgs: '"focus tests"',
      commandName: "skill-review verify",
      displayPrompt: '/skill-review /verify "focus tests"',
      kind: "submit",
      prompt: '"focus tests"',
    });

    const oneSkill = resolveSlashCommand("/verify", commands);
    if (oneSkill.kind !== "found" || oneSkill.command.kind !== "prompt") {
      throw new Error("Expected one resolved Skill command.");
    }
    expect(oneSkill.command.getSubmission({} as never, oneSkill.arguments)).toEqual({
      activatedSkills: ["verify"],
      commandName: "verify",
      displayPrompt: "/verify",
      kind: "submit",
      prompt: "Run the activated Skill.",
    });

    const twoSkills = resolveSlashCommand("/skill-review /verify", commands);
    if (twoSkills.kind !== "found" || twoSkills.command.kind !== "prompt") {
      throw new Error("Expected two resolved Skill commands.");
    }
    expect(twoSkills.command.getSubmission({} as never, twoSkills.arguments)).toMatchObject({
      activatedSkills: ["skill-review", "verify"],
      prompt: "Run the activated Skills.",
    });
  });

  it("limits one invocation to six Skills", () => {
    const commands = createSlashCommands(
      Array.from({ length: 7 }, (_, index) => ({ name: `skill-${index + 1}` })),
    );
    const input = commands
      .filter((command) => command.source === "skill")
      .map((command) => `/${command.name}`)
      .join(" ");

    expect(resolveSlashCommand(input, commands)).toMatchObject({
      kind: "invalid",
      message: "At most 6 Skills can be chained.",
    });
  });

  it("registers namespaced Agent commands and runs their persisted profile", async () => {
    const commands = createSlashCommands(
      [],
      [
        {
          deliverable: "A focused review.",
          description: "Review authentication.",
          id: "user-agent-1",
          name: "security-reviewer",
        },
      ],
    );
    const command = commands.find((candidate) => candidate.name === "agent:security-reviewer");
    const runAgent = vi.fn(async () => ({
      agentId: "agent-1",
      finalOutput: "Review complete.",
      profileId: "user-agent-1",
      status: "succeeded" as const,
      taskId: "task-1",
    }));

    expect(command).toMatchObject({
      kind: "local",
      source: "agent",
    });
    expect(
      getSlashCommandSuggestions("/agent:sec", 10, commands).map((candidate) => candidate.name),
    ).toEqual(["agent:security-reviewer"]);
    if (command?.kind !== "local") {
      throw new Error("Expected a local Agent command.");
    }
    await expect(
      command.execute({ runAgent } as never, parseSlashCommandArguments("inspect authentication")),
    ).resolves.toMatchObject({
      message: expect.stringContaining("Review complete."),
      title: "Agent · security-reviewer",
    });
    expect(runAgent).toHaveBeenCalledWith("user-agent-1", "inspect authentication");
  });

  it("returns the complete typed built-in command catalog", () => {
    const commands = createSlashCommands([]);
    const names = commands.map((command) => command.name);
    const namesAndAliases = commands.flatMap((command) => [
      command.name,
      ...(command.aliases ?? []),
    ]);

    expect(names).toEqual([
      "clear",
      "help",
      "agent-new",
      "agents",
      "status",
      "context",
      "usage",
      "tasks",
      "memory",
      "skills",
      "compact",
      "init",
      "doctor",
      "cancel",
      "hooks",
      "resume",
      "rename",
      "branch",
      "rewind",
      "model",
      "mcp",
      "output-style",
      "review",
      "copy",
      "export",
      "spec:brainstorm",
      "spec:write-plan",
      "spec:execute-plan",
      "spec:save-design",
      "exit",
    ]);
    expect(new Set(namesAndAliases).size).toBe(namesAndAliases.length);
    expect(commands.every((command) => command.source === "builtin")).toBe(true);
    expect(
      getSlashCommandSuggestions("/spec:", 6, commands).map((command) => command.name),
    ).toEqual(["spec:brainstorm", "spec:write-plan", "spec:execute-plan", "spec:save-design"]);
  });

  it("prevents Skills from shadowing built-in names and aliases", () => {
    const commands = createSlashCommands([
      { name: "review" },
      { name: "reset" },
      { name: "workflow-review" },
    ]);

    expect(
      commands.filter((command) => command.source === "skill").map((command) => command.name),
    ).toEqual(["workflow-review"]);
    const workflowReview = commands.find((command) => command.name === "workflow-review");
    if (workflowReview?.kind !== "prompt") {
      throw new Error("Expected a workflow review Skill.");
    }
    expect(workflowReview.getSubmission({} as never, parseSlashCommandArguments(""))).toMatchObject(
      {
        displayPrompt: "/workflow-review",
        prompt: "Run the activated Skill.",
      },
    );
  });

  it("preserves interactive command callbacks during resolution", async () => {
    const open = async () => ({ kind: "success" as const, message: "opened" });
    const command: InteractiveSlashCommand = {
      description: "Open a picker",
      kind: "interactive",
      name: "picker",
      open,
      source: "builtin",
    };
    const resolution = resolveSlashCommand("/picker", [command]);

    expect(resolution).toMatchObject({
      command: {
        kind: "interactive",
        open,
      },
      kind: "found",
    });
    if (resolution.kind !== "found" || resolution.command.kind !== "interactive") {
      throw new Error("Expected an interactive command.");
    }
    await expect(resolution.command.open({} as never, resolution.arguments)).resolves.toEqual({
      kind: "success",
      message: "opened",
    });
  });
});
