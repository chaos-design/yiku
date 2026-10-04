import { describe, expect, it, vi } from "vitest";
import { copyCommand } from "../../../src/slash-commands/builtin/copy.js";
import { doctorCommand } from "../../../src/slash-commands/builtin/doctor.js";
import { exportCommand } from "../../../src/slash-commands/builtin/export.js";
import { initCommand } from "../../../src/slash-commands/builtin/init.js";
import { reviewCommand } from "../../../src/slash-commands/builtin/review.js";
import { specBrainstormCommand } from "../../../src/slash-commands/builtin/spec-brainstorm.js";
import { specExecutePlanCommand } from "../../../src/slash-commands/builtin/spec-execute-plan.js";
import { specSaveDesignCommand } from "../../../src/slash-commands/builtin/spec-save-design.js";
import { specWritePlanCommand } from "../../../src/slash-commands/builtin/spec-write-plan.js";
import { statusCommand } from "../../../src/slash-commands/builtin/status.js";
import { tasksCommand } from "../../../src/slash-commands/builtin/tasks.js";
import { usageCommand } from "../../../src/slash-commands/builtin/usage.js";
import type {
  PromptSlashCommand,
  SlashCommandArguments,
  SlashCommandContext,
} from "../../../src/slash-commands/types.js";

describe("workflow prompt commands", () => {
  it("reviews staged changes without lockfile noise", async () => {
    const submission = await submit(reviewCommand);

    expect(reviewCommand).toMatchObject({
      kind: "prompt",
      name: "review",
      progressLabel: "Preparing code review",
      source: "builtin",
    });
    expect(submission).toMatchObject({
      activatedSkills: [],
      commandName: "review",
      displayPrompt: "/review",
      kind: "submit",
    });
    expect(submission.prompt).toContain("git diff --cached");
    expect(submission.prompt).toContain("pnpm-lock.yaml");
    expect(submission.prompt).toContain("package-lock.json");
    expect(submission.prompt).toContain("findings first");
    expectSharedInstructions(submission.prompt);
  });

  it("reviews a pull request through gh", async () => {
    const submission = await submit(reviewCommand, "42");

    expect(submission.commandArgs).toBe("42");
    expect(submission.displayPrompt).toBe("/review 42");
    expect(submission.prompt).toContain("gh pr diff 42");
  });

  it("creates a design through a read-only brainstorming workflow", async () => {
    const submission = await submit(specBrainstormCommand, "typed slash commands");

    expect(specBrainstormCommand).toMatchObject({
      kind: "prompt",
      name: "spec:brainstorm",
      progressLabel: "Brainstorming specification",
    });
    expect(submission.prompt).toContain("typed slash commands");
    expect(submission.prompt).toContain("Do not edit code");
    expect(submission.prompt).toContain("one clarifying question at a time");
    expectSharedInstructions(submission.prompt);
  });

  it("writes an implementation plan with exact files and verification", async () => {
    const submission = await submit(specWritePlanCommand, "approved command design");

    expect(specWritePlanCommand).toMatchObject({
      kind: "prompt",
      name: "spec:write-plan",
      progressLabel: "Writing implementation plan",
    });
    expect(submission.prompt).toContain("approved command design");
    expect(submission.prompt).toContain("exact file paths");
    expect(submission.prompt).toContain("focused tests");
    expectSharedInstructions(submission.prompt);
  });

  it("executes a plan in verified batches", async () => {
    const submission = await submit(specExecutePlanCommand, "docs/plans/commands.md");

    expect(specExecutePlanCommand).toMatchObject({
      kind: "prompt",
      name: "spec:execute-plan",
      progressLabel: "Executing implementation plan",
    });
    expect(submission.prompt).toContain("docs/plans/commands.md");
    expect(submission.prompt).toContain("batches");
    expect(submission.prompt).toContain("checkpoint");
    expectSharedInstructions(submission.prompt);
  });

  it("saves an approved design under the dated design path", async () => {
    const submission = await submit(specSaveDesignCommand, "typed-commands");

    expect(specSaveDesignCommand).toMatchObject({
      kind: "prompt",
      name: "spec:save-design",
      progressLabel: "Saving approved design",
    });
    expect(submission.prompt).toContain("typed-commands");
    expect(submission.prompt).toContain("docs/designs/YYYY-MM-DD-<slug>.md");
    expectSharedInstructions(submission.prompt);
  });

  it("uses conversation defaults when specification commands have no arguments", async () => {
    for (const [command, fallback] of [
      [specBrainstormCommand, "Use the current conversation"],
      [specWritePlanCommand, "Use the approved design in the current conversation"],
      [specExecutePlanCommand, "Use the implementation plan approved in the current conversation"],
      [specSaveDesignCommand, "Derive a concise lowercase kebab-case slug"],
    ] as const) {
      const submission = await submit(command);
      expect(submission).not.toHaveProperty("commandArgs");
      expect(submission.displayPrompt).toBe(`/${command.name}`);
      expect(submission.prompt).toContain(fallback);
    }
  });
});

describe("workflow local commands", () => {
  it("returns the exact empty-state message when there is no assistant response", async () => {
    const write = vi.fn(async (_text: string) => undefined);
    const context = {
      clipboard: { write },
      lastAssistantText: () => undefined,
    } as unknown as SlashCommandContext;

    await expect(copyCommand.execute(context, commandArguments())).resolves.toEqual({
      kind: "error",
      message: "No assistant message to copy.",
      title: "Command Error",
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("copies the last assistant response and reports character and line counts", async () => {
    const assistantText = "First line\r\nSecond line\nThird line";
    const write = vi.fn(async (_text: string) => undefined);
    const context = {
      clipboard: { write },
      lastAssistantText: () => assistantText,
    } as unknown as SlashCommandContext;

    await expect(copyCommand.execute(context, commandArguments())).resolves.toEqual({
      kind: "success",
      message: `Copied ${assistantText.length} characters across 3 lines.`,
      title: "Copied",
    });
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(assistantText);
  });

  it("exports to the default or requested path and reports the resolved result", async () => {
    const exportSession = vi.fn(async (filePath?: string) => ({
      filePath: filePath === undefined ? "/exports/session-1.md" : `/workspace/${filePath}`,
      messageCount: filePath === undefined ? 4 : 5,
    }));
    const context = { exportSession } as unknown as SlashCommandContext;

    await expect(exportCommand.execute(context, commandArguments())).resolves.toEqual({
      kind: "success",
      message: "Exported 4 messages to /exports/session-1.md.",
      title: "Session Exported",
    });
    await expect(
      exportCommand.execute(
        context,
        commandArguments('"reports/session export.md"', ["reports/session export.md"]),
      ),
    ).resolves.toEqual({
      kind: "success",
      message: "Exported 5 messages to /workspace/reports/session export.md.",
      title: "Session Exported",
    });
    expect(exportSession).toHaveBeenNthCalledWith(1, undefined);
    expect(exportSession).toHaveBeenNthCalledWith(2, "reports/session export.md");
  });

  it("rejects unsupported local command arguments", async () => {
    await expect(
      copyCommand.execute({} as SlashCommandContext, commandArguments("extra", ["extra"])),
    ).resolves.toEqual({
      kind: "error",
      message: "Usage: /copy",
      title: "Command Error",
    });
    await expect(
      exportCommand.execute({} as SlashCommandContext, commandArguments("one two", ["one", "two"])),
    ).resolves.toEqual({
      kind: "error",
      message: "Usage: /export [filePath]",
      title: "Command Error",
    });
  });

  it("uses the builtin LocalSlashCommand metadata", () => {
    expect(copyCommand).toMatchObject({
      kind: "local",
      name: "copy",
      source: "builtin",
    });
    expect(exportCommand).toMatchObject({
      execution: "idle",
      kind: "local",
      name: "export",
      source: "builtin",
    });
  });

  it("validates no-argument setup and status commands", async () => {
    const context = {
      getSessionStatus: () => "session",
      getTaskSummary: () => "tasks",
      getUsageSummary: () => "usage",
      runSetup: vi.fn(async () => undefined),
    } as unknown as SlashCommandContext;
    const extra = commandArguments("extra", ["extra"]);

    for (const [command, usage] of [
      [doctorCommand, "Usage: /doctor"],
      [initCommand, "Usage: /init"],
      [statusCommand, "Usage: /status"],
      [tasksCommand, "Usage: /tasks"],
      [usageCommand, "Usage: /usage"],
    ] as const) {
      await expect(Promise.resolve(command.execute(context, extra))).resolves.toMatchObject({
        kind: "error",
        message: usage,
      });
    }
    expect(context.runSetup).not.toHaveBeenCalled();
  });
});

async function submit(command: PromptSlashCommand, raw = "") {
  const arguments_: SlashCommandArguments = {
    raw,
    values: raw ? [raw] : [],
  };

  return command.getSubmission({} as never, arguments_);
}

function commandArguments(
  raw = "",
  values: readonly string[] = raw ? [raw] : [],
): SlashCommandArguments {
  return { raw, values };
}

function expectSharedInstructions(prompt: string): void {
  expect(prompt).toContain("current conversation language");
  expect(prompt).toContain("TodoWrite");
  expect(prompt).toContain("Do not create Git commits");
}
