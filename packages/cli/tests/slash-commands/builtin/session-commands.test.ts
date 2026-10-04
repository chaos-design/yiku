import { createInitialSessionState } from "@yiku/agent-orchestrator";
import { describe, expect, it, vi } from "vitest";
import { branchCommand } from "../../../src/slash-commands/builtin/branch.js";
import { renameCommand } from "../../../src/slash-commands/builtin/rename.js";
import { resumeCommand } from "../../../src/slash-commands/builtin/resume.js";
import { rewindCommand } from "../../../src/slash-commands/builtin/rewind.js";
import type {
  InteractiveSlashCommand,
  SlashCommandArguments,
  SlashCommandContext,
  SlashCommandSessions,
} from "../../../src/slash-commands/types.js";

describe("Session slash commands", () => {
  it("resumes directly or opens the Session picker", async () => {
    const sessions = sessionService();
    const context = { sessions } as unknown as SlashCommandContext;

    await expect(open(resumeCommand, context, ["target"])).resolves.toMatchObject({
      kind: "success",
      message: "Resumed Session: target",
    });
    expect(sessions.switch).toHaveBeenCalledWith("target");

    const overlay = await open(resumeCommand, context);
    expect(overlay).toMatchObject({
      currentSessionId: "current",
      kind: "session-picker",
      title: "Resume Session",
    });
    if (overlay.kind !== "session-picker") {
      throw new Error("Expected a Session picker.");
    }
    await overlay.onRename("target", "Alternative");
    await overlay.onDelete("target");
    await overlay.onSelect("target");
    expect(sessions.rename).toHaveBeenCalledWith("Alternative", "target");
    expect(sessions.remove).toHaveBeenCalledWith("target");
    expect(sessions.switch).toHaveBeenLastCalledWith("target");
  });

  it("renames and branches the current Session", async () => {
    const sessions = sessionService();
    const context = { sessions } as unknown as SlashCommandContext;

    await expect(renameCommand.execute(context, args(["New title"]))).resolves.toMatchObject({
      kind: "success",
      message: "Session renamed to: New title",
    });
    await expect(branchCommand.execute(context, args(["Alternative"]))).resolves.toMatchObject({
      kind: "success",
      message: "Branched to Session: current",
    });
    expect(sessions.rename).toHaveBeenCalledWith("New title");
    expect(sessions.branch).toHaveBeenCalledWith("Alternative");
  });

  it("branches without a title and reports a generated Session fallback", async () => {
    const sessions = sessionService();
    sessions.currentSessionId = vi.fn(async () => undefined);
    const context = { sessions } as unknown as SlashCommandContext;

    await expect(branchCommand.execute(context, args([]))).resolves.toMatchObject({
      kind: "success",
      message: "Branched to Session: new Session",
    });
    expect(sessions.branch).toHaveBeenCalledWith(undefined);
  });

  it("requires the checkpoint picker confirmation for every rewind", async () => {
    const sessions = sessionService();
    const context = { sessions } as unknown as SlashCommandContext;

    const direct = await open(rewindCommand, context, ["checkpoint-1"]);
    expect(direct).toMatchObject({
      checkpoints: [expect.objectContaining({ id: "checkpoint-1" })],
      kind: "checkpoint-picker",
    });
    expect(sessions.rewind).not.toHaveBeenCalled();
    const overlay = await open(rewindCommand, context);
    expect(overlay).toMatchObject({
      checkpoints: [expect.objectContaining({ id: "checkpoint-1" })],
      kind: "checkpoint-picker",
    });
    if (overlay.kind !== "checkpoint-picker") {
      throw new Error("Expected a checkpoint picker.");
    }
    await overlay.onSelect("checkpoint-1");
    expect(sessions.rewind).toHaveBeenCalledOnce();
    await expect(open(rewindCommand, context, ["missing"])).resolves.toMatchObject({
      kind: "error",
      message: "Checkpoint not found: missing",
    });
  });

  it("validates required and extra arguments", async () => {
    const context = { sessions: sessionService() } as unknown as SlashCommandContext;
    await expect(renameCommand.execute(context, args([]))).resolves.toMatchObject({
      kind: "error",
      message: "Usage: /rename <title>",
    });
    await expect(open(resumeCommand, context, ["one", "two"])).resolves.toMatchObject({
      kind: "error",
    });
    await expect(open(rewindCommand, context, ["one", "two"])).resolves.toMatchObject({
      kind: "error",
    });
  });
});

function open(
  command: InteractiveSlashCommand,
  context: SlashCommandContext,
  values: readonly string[] = [],
) {
  return command.open(context, args(values));
}

function args(values: readonly string[]): SlashCommandArguments {
  return {
    raw: values.join(" "),
    values,
  };
}

function sessionService(): SlashCommandSessions {
  return {
    branch: vi.fn(async () => undefined),
    checkpoints: vi.fn(async () => [
      {
        createdAt: "2026-08-10T00:00:00.000Z",
        historyEntries: [],
        id: "checkpoint-1",
        prompt: "first",
        sessionRevision: 1,
      },
    ]),
    currentSessionId: vi.fn(async () => "current"),
    list: vi.fn(async () => [
      {
        ...createInitialSessionState({
          agentKey: "code",
          configFingerprint: "config",
          modelKey: "model",
          now: "2026-08-10T00:00:00.000Z",
          sessionId: "target",
          workspaceDir: "/workspace",
        }),
        title: "Target",
      },
    ]),
    remove: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    rewind: vi.fn(async () => undefined),
    switch: vi.fn(async () => undefined),
  };
}
