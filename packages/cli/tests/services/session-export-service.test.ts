import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionExportService } from "../../src/services/session-export-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("SessionExportService", () => {
  it("projects supported envelopes to the default Markdown artifact", async () => {
    const fixture = await createFixture();
    await writeEvents(fixture.eventLogPath, [
      envelope({
        kind: "session_lifecycle",
        phase: "session_started",
        values: {
          model: "gpt-test",
          prompt: "Inspect the workspace.",
        },
      }),
      envelope({ kind: "assistant_delta", text: "Hello " }),
      envelope({ kind: "assistant_delta", text: "world." }),
      envelope(
        {
          input: { authorization: "Bearer secret-value", path: "src/index.ts" },
          kind: "tool_called",
          summary: "read source",
          title: "Read",
          toolName: "readFileTool",
        },
        { toolCallId: "call-1" },
      ),
      envelope(
        {
          kind: "tool_output",
          output: { content: "source", token: "secret-value" },
          summary: "read source",
          title: "Read",
          toolName: "readFileTool",
        },
        { toolCallId: "call-1" },
      ),
      envelope({ kind: "reasoning", secret: "reasoning-secret" }),
      envelope({
        action: "allow",
        eventName: "PreToolUse",
        kind: "hook_decision",
        reasons: ["hook-secret"],
      }),
      envelope(
        {
          agentName: "Reviewer",
          agentType: "code",
          kind: "agent_spawned",
          profileId: "reviewer",
          prompt: "Review the workspace",
        },
        {
          agentId: "child-1",
          agentSessionId: "session-1.agent.child-1",
          parentAgentId: "root",
          taskId: "task-1",
        },
      ),
      envelope(
        {
          agentName: "Reviewer",
          kind: "agent_output",
          profileId: "reviewer",
          text: "Review complete",
        },
        {
          agentId: "child-1",
          agentSessionId: "session-1.agent.child-1",
          parentAgentId: "root",
          taskId: "task-1",
        },
      ),
      envelope(
        {
          agentName: "Reviewer",
          kind: "agent_finished",
          profileId: "reviewer",
          status: "succeeded",
        },
        {
          agentId: "child-1",
          agentSessionId: "session-1.agent.child-1",
          parentAgentId: "root",
          taskId: "task-1",
        },
      ),
      envelope({ action: "created", checkpointId: "checkpoint-1", kind: "checkpoint" }),
      envelope({
        kind: "usage",
        model: "gpt-test",
        usage: {
          cachedInputTokens: 3,
          inputTokens: 10,
          outputTokens: 4,
          peakInputTokens: 10,
          totalTokens: 14,
        },
      }),
    ]);
    const service = new SessionExportService({
      ...fixture,
      model: "gpt-test",
      title: "Workspace review",
    });

    const result = await service.export({ sessionId: "session-1" });

    expect(result).toEqual({
      filePath: join(fixture.exportsDir, "session-1.md"),
      messageCount: 9,
    });
    const markdown = await readFile(result.filePath, "utf8");
    expect(markdown).toContain("# Yiku Session Export");
    expect(markdown).toContain("Session ID: `session-1`");
    expect(markdown).toContain("Title: Workspace review");
    expect(markdown).toContain("Model: `gpt-test`");
    expect(markdown).toContain("Workspace: `");
    expect(markdown).toContain("## User");
    expect(markdown).toContain("Inspect the workspace.");
    expect(markdown.match(/## Assistant/g)).toHaveLength(1);
    expect(markdown).toContain("Hello world.");
    expect(markdown).toContain("## Tool Called: Read");
    expect(markdown).toContain('"path": "src/index.ts"');
    expect(markdown).toContain("## Tool Output: Read");
    expect(markdown).toContain("## Agent Spawned: Reviewer");
    expect(markdown).toContain("Agent Session: `session-1.agent.child-1`");
    expect(markdown).toContain("## Agent Output: Reviewer");
    expect(markdown).toContain("Review complete");
    expect(markdown).toContain("## Agent Finished: Reviewer");
    expect(markdown).toContain("## Checkpoint: created");
    expect(markdown).toContain("## Usage: gpt-test");
    expect(markdown).toContain("- Total tokens: 14");
    expect(markdown).toContain("[REDACTED]");
    expect(markdown).not.toContain("reasoning-secret");
    expect(markdown).not.toContain("hook-secret");
    expect(markdown).not.toContain("secret-value");
    expect((await stat(result.filePath)).mode & 0o777).toBe(0o644);
    expect((await readdir(fixture.exportsDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("resolves supplied paths from the workspace and rejects paths outside it", async () => {
    const fixture = await createFixture();
    await writeEvents(fixture.eventLogPath, [envelope({ kind: "assistant_delta", text: "Done" })]);
    const service = new SessionExportService(fixture);

    const relative = await service.export({
      filePath: "reports/session.md",
      sessionId: "session-1",
    });
    const absolutePath = join(fixture.workspaceDir, "absolute.md");
    const absolute = await service.export({
      filePath: absolutePath,
      sessionId: "session-1",
    });

    expect(relative.filePath).toBe(join(fixture.workspaceDir, "reports", "session.md"));
    expect(absolute.filePath).toBe(absolutePath);
    await expect(
      service.export({ filePath: "../outside.md", sessionId: "session-1" }),
    ).rejects.toThrow("Export path must stay within the workspace.");
    await expect(
      service.export({ filePath: join(fixture.root, "outside.md"), sessionId: "session-1" }),
    ).rejects.toThrow("Export path must stay within the workspace.");
  });

  it("fails immediately with the one-based line number for malformed JSON", async () => {
    const fixture = await createFixture();
    await writeFile(
      fixture.eventLogPath,
      `${JSON.stringify(envelope({ kind: "assistant_delta", text: "Before" }))}\n{bad-json\n`,
    );
    const service = new SessionExportService(fixture);

    await expect(service.export({ sessionId: "session-1" })).rejects.toThrow(
      "Invalid Session event log at line 2:",
    );
    await expect(readdir(fixture.exportsDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports invalid envelopes and mismatched Sessions with their line numbers", async () => {
    const fixture = await createFixture();
    await writeEvents(fixture.eventLogPath, [{ payload: { kind: "reasoning" } }]);
    const service = new SessionExportService(fixture);
    await expect(service.export({ sessionId: "session-1" })).rejects.toThrow(
      "Invalid Session event log at line 1:",
    );

    await writeEvents(fixture.eventLogPath, [
      envelope({ kind: "assistant_delta", text: "Other" }, { sessionId: "session-2" }),
    ]);
    await expect(service.export({ sessionId: "session-1" })).rejects.toThrow(
      "Invalid Session event log at line 1: expected Session session-1, received session-2.",
    );
  });

  it("bounds deeply nested and oversized structured values", async () => {
    const fixture = await createFixture();
    await writeEvents(fixture.eventLogPath, [
      envelope({
        kind: "tool_output",
        output: {
          deep: { one: { two: { three: { four: { five: { six: "hidden" } } } } } },
          items: Array.from({ length: 80 }, (_, index) => index),
          text: "x".repeat(10_000),
        },
        summary: "large output",
        title: "Large",
        toolName: "largeTool",
      }),
    ]);
    const service = new SessionExportService(fixture);

    const result = await service.export({ sessionId: "session-1" });
    const markdown = await readFile(result.filePath, "utf8");

    expect(markdown).toContain("[Maximum depth reached]");
    expect(markdown).toContain("[30 more items]");
    expect(markdown).toContain("[6000 more characters]");
    expect(Buffer.byteLength(markdown)).toBeLessThan(20_000);
  });

  it("projects sparse events and omits unsupported lifecycle details", async () => {
    const fixture = await createFixture();
    await writeEvents(fixture.eventLogPath, [
      envelope({ kind: "assistant_delta", text: "   " }),
      envelope({ kind: "assistant_delta", text: "child answer" }, { agentId: "child#1" }),
      envelope({
        kind: "tool_called",
        summary: "run\nsparse",
        title: "Sparse#Tool",
        toolName: "sparse",
      }),
      envelope({ agentType: "code", kind: "agent_spawned", profileId: "profile" }),
      envelope({ kind: "agent_finished", status: "cancelled" }),
      envelope({ kind: "session_lifecycle", phase: "session_resumed" }),
      envelope({
        kind: "session_lifecycle",
        phase: "session_started",
        values: { prompt: "" },
      }),
      envelope({
        from: "sandbox",
        kind: "runtime_boundary_changed",
        reason: "fallback",
        to: "host-policy",
      }),
      envelope({
        durationMs: 2,
        endedAt: "2026-08-10T00:00:00.002Z",
        kind: "memory_operation",
        namespaceHash: "a1b2c3d4e5f6a7b8",
        operation: "recall",
        operationId: "memory-1",
        phase: "end",
        startedAt: "2026-08-10T00:00:00.000Z",
      }),
    ]);
    const service = new SessionExportService({
      ...fixture,
      model: " ",
      title: " ",
    });

    const result = await service.export({ sessionId: "session-1" });
    const markdown = await readFile(result.filePath, "utf8");

    expect(result.messageCount).toBe(4);
    expect(markdown).toContain("## Assistant: child\\#1");
    expect(markdown).toContain("## Tool Called: Sparse\\#Tool");
    expect(markdown).not.toContain("Tool Call ID");
    expect(markdown).not.toContain("- Model:");
    expect(markdown).not.toContain("- Title:");
    expect(markdown).not.toContain("runtime_boundary_changed");
  });

  it("validates constructor paths, IDs, paths, and payload variants", async () => {
    const fixture = await createFixture();
    expect(
      () =>
        new SessionExportService({
          ...fixture,
          eventLogPath: "relative.jsonl",
        }),
    ).toThrow("Session event log path must be absolute");
    expect(
      () =>
        new SessionExportService({
          ...fixture,
          exportsDir: "relative",
        }),
    ).toThrow("Session exports directory path must be absolute");
    expect(
      () =>
        new SessionExportService({
          ...fixture,
          workspaceDir: "relative",
        }),
    ).toThrow("Workspace path must be absolute");

    const service = new SessionExportService(fixture);
    await expect(service.export({ sessionId: " " })).rejects.toThrow("Session ID is required");
    await expect(service.export({ filePath: " ", sessionId: "session-1" })).rejects.toThrow(
      "Export path must not be empty",
    );
    await expect(service.export({ sessionId: "../outside" })).rejects.toThrow(
      "Session ID cannot be used as an export file name",
    );

    const invalidPayloads = [
      { kind: "agent_finished", status: "unknown" },
      { kind: "hook_decision", action: "allow", eventName: "PreToolUse", reasons: "bad" },
      { kind: "checkpoint", action: "unknown", checkpointId: "checkpoint" },
      {
        kind: "memory_operation",
        namespaceHash: "",
        operation: "recall",
        operationId: "memory-1",
        phase: "end",
        startedAt: "2026-08-10T00:00:00.000Z",
      },
      { kind: "runtime_boundary_changed", from: "", reason: "failure", to: "host-policy" },
      { kind: "unsupported" },
    ];
    for (const payload of invalidPayloads) {
      await writeEvents(fixture.eventLogPath, [envelope(payload)]);
      await expect(service.export({ sessionId: "session-1" })).rejects.toThrow(
        "Invalid Session event log at line 1:",
      );
    }
  });
});

interface Fixture {
  readonly eventLogPath: string;
  readonly exportsDir: string;
  readonly root: string;
  readonly workspaceDir: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "yiku-session-export-"));
  temporaryDirectories.push(root);
  const workspaceDir = join(root, "workspace");
  const storageDir = join(root, "storage");
  const eventLogPath = join(storageDir, "session", "session-1.events.jsonl");
  const exportsDir = join(storageDir, "exports");
  await Promise.all([
    mkdir(workspaceDir, { recursive: true }),
    mkdir(join(storageDir, "session"), { recursive: true }),
  ]);
  return { eventLogPath, exportsDir, root, workspaceDir };
}

async function writeEvents(path: string, events: readonly unknown[]): Promise<void> {
  await writeFile(path, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

interface EnvelopeOptions {
  readonly agentId?: string;
  readonly agentSessionId?: string;
  readonly parentAgentId?: string;
  readonly sessionId?: string;
  readonly taskId?: string;
  readonly toolCallId?: string;
}

let eventSequence = 0;

function envelope(payload: unknown, options: EnvelopeOptions = {}) {
  eventSequence += 1;
  return {
    agentId: options.agentId ?? "root",
    ...(options.agentSessionId !== undefined ? { agentSessionId: options.agentSessionId } : {}),
    eventId: `event-${eventSequence}`,
    occurredAt: "2026-08-10T00:00:00.000Z",
    ...(options.parentAgentId !== undefined ? { parentAgentId: options.parentAgentId } : {}),
    payload,
    sessionId: options.sessionId ?? "session-1",
    ...(options.taskId !== undefined ? { taskId: options.taskId } : {}),
    ...(options.toolCallId !== undefined ? { toolCallId: options.toolCallId } : {}),
  };
}
