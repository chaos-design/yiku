import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createInitialSessionState } from "../../src/session/session-state.js";
import { SessionStore } from "../../src/session/session-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("SessionStore", () => {
  it("persists atomically with private permissions and revision checks", async () => {
    const directory = await temporaryDirectory();
    const steps: string[] = [];
    let now = "2026-08-01T00:00:00.000Z";
    const store = new SessionStore({
      now: () => new Date(now),
      onAtomicWriteStep: (step) => steps.push(step),
      sessionsDir: directory,
    });
    const initial = state("session-1", "/workspace", now);

    await store.create(initial);
    expect(await store.load("session-1")).toEqual(initial);
    expect((await stat(store.stateFilePath("session-1"))).mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect(steps).toEqual(["mkdir", "write", "file-sync", "rename", "directory-sync", "chmod"]);

    now = "2026-08-01T00:00:01.000Z";
    const updated = await store.update("session-1", 1, (current) => ({
      ...current,
      status: "paused",
    }));
    expect(updated.revision).toBe(2);
    expect(updated.updatedAt).toBe(now);
    await expect(store.update("session-1", 1, (current) => current)).rejects.toThrow(
      "Session revision conflict",
    );

    const [paused, titled] = await Promise.all([
      store.updateCurrent("session-1", (current) => ({
        ...current,
        status: "paused",
      })),
      store.updateCurrent("session-1", (current) => ({
        ...current,
        title: "Concurrent title",
      })),
    ]);
    expect([paused.revision, titled.revision]).toEqual([3, 4]);
    expect(await store.load("session-1")).toMatchObject({
      revision: 4,
      status: "paused",
      title: "Concurrent title",
    });
    await store.close();
  });

  it("redacts sensitive summaries before writing state", async () => {
    const directory = await temporaryDirectory();
    const store = new SessionStore({ sessionsDir: directory });
    const initial = {
      ...state("redacted", "/workspace", "2026-08-01T00:00:00.000Z"),
      inFlightOperations: [
        {
          callId: "call-1",
          effect: "external" as const,
          inputSummary: "api_key=super-secret-value",
          stageId: "stage-1",
          startedAt: "2026-08-01T00:00:01.000Z",
          toolName: "externalTool",
        },
      ],
    };

    await store.create(initial);
    const content = await readFile(store.stateFilePath("redacted"), "utf8");

    expect(content).not.toContain("super-secret-value");
    expect(content).toContain("[REDACTED]");
    await store.close();
  });

  it("renames sessions through a revisioned update and validates titles", async () => {
    const directory = await temporaryDirectory();
    const store = new SessionStore({
      now: () => new Date("2026-08-01T00:00:01.000Z"),
      sessionsDir: directory,
    });
    await store.create(state("session-1", "/workspace", "2026-08-01T00:00:00.000Z"));

    const renamed = await store.rename("session-1", "  Timer layout  ");

    expect(renamed).toMatchObject({
      revision: 2,
      title: "Timer layout",
      updatedAt: "2026-08-01T00:00:01.000Z",
    });
    await expect(store.rename("session-1", " ")).rejects.toThrow("between 1 and 200");
    await expect(store.rename("session-1", "x".repeat(201))).rejects.toThrow("between 1 and 200");
    await store.close();
  });

  it("clones durable context into a clean active epoch", async () => {
    const directory = await temporaryDirectory();
    const clonedAt = "2026-08-01T00:00:10.000Z";
    const store = new SessionStore({
      now: () => new Date(clonedAt),
      sessionsDir: directory,
    });
    const source = await store.create({
      ...state("session-1", "/workspace", "2026-08-01T00:00:00.000Z"),
      budget: {
        epoch: 3,
        noProgressStages: 2,
        progressRevision: 8,
        stage: 4,
        toolCalls: 7,
        totalStages: 12,
      },
      checkpointHead: "checkpoint-1",
      history: {
        entries: [
          { content: "question", role: "user" },
          { content: "answer", role: "assistant" },
        ],
        summary: "Existing context",
      },
      inFlightOperations: [
        {
          callId: "call-1",
          effect: "write",
          inputSummary: "modify file",
          stageId: "stage-4",
          startedAt: "2026-08-01T00:00:01.000Z",
          toolName: "edit",
        },
      ],
      lastCompletedOperation: {
        callId: "call-0",
        completedAt: "2026-08-01T00:00:01.000Z",
        effect: "read",
        inputSummary: "read file",
        stageId: "stage-3",
        status: "succeeded",
        toolName: "read",
      },
      outputStyle: "compact",
      pendingInput: {
        kind: "side-effect-review",
        message: "Review the interrupted write.",
      },
      status: "needs-review",
      title: "Original",
    });

    const branch = await store.clone("session-1", {
      sessionId: "session-2",
      title: "  Alternative  ",
    });

    expect(branch).toMatchObject({
      agentKey: source.agentKey,
      budget: {
        epoch: 4,
        noProgressStages: 0,
        progressRevision: 8,
        stage: 0,
        toolCalls: 0,
        totalStages: 12,
      },
      checkpointHead: source.checkpointHead,
      configFingerprint: source.configFingerprint,
      createdAt: clonedAt,
      eventLogPath: "session-2.events.jsonl",
      history: source.history,
      inFlightOperations: [],
      modelKey: source.modelKey,
      outputStyle: source.outputStyle,
      revision: 1,
      sessionId: "session-2",
      status: "active",
      title: "Alternative",
      updatedAt: clonedAt,
    });
    expect(branch).not.toHaveProperty("lastCompletedOperation");
    expect(branch).not.toHaveProperty("pendingInput");
    await expect(store.clone("session-1", { sessionId: "../escape" })).rejects.toThrow(
      "unsupported characters",
    );
    await expect(store.clone("session-1", { sessionId: "session-2" })).rejects.toThrow(
      "already exists",
    );
    expect(await store.load("session-2")).toEqual(branch);
    await store.close();
  });

  it.each(["active", "paused", "completed", "failed"] as const)(
    "starts a new epoch from %s status",
    async (status) => {
      const directory = await temporaryDirectory();
      const store = new SessionStore({
        now: () => new Date("2026-08-01T00:00:05.000Z"),
        sessionsDir: directory,
      });
      await store.create({
        ...state(`session-${status}`, "/workspace", "2026-08-01T00:00:00.000Z"),
        budget: {
          epoch: 2,
          noProgressStages: 3,
          progressRevision: 6,
          stage: 4,
          toolCalls: 5,
          totalStages: 9,
        },
        status,
      });

      const started = await store.startEpoch(`session-${status}`);

      expect(started).toMatchObject({
        budget: {
          epoch: 3,
          noProgressStages: 0,
          progressRevision: 6,
          stage: 0,
          toolCalls: 0,
          totalStages: 9,
        },
        revision: 2,
        status: "active",
        updatedAt: "2026-08-01T00:00:05.000Z",
      });
      await store.close();
    },
  );

  it("rejects a new epoch while operations or side-effect review remain unresolved", async () => {
    const directory = await temporaryDirectory();
    const store = new SessionStore({ sessionsDir: directory });
    await store.create({
      ...state("in-flight", "/workspace", "2026-08-01T00:00:00.000Z"),
      inFlightOperations: [
        {
          callId: "call-1",
          effect: "write",
          inputSummary: "modify file",
          stageId: "stage-1",
          startedAt: "2026-08-01T00:00:01.000Z",
          toolName: "edit",
        },
      ],
    });
    await store.create({
      ...state("pending-review", "/workspace", "2026-08-01T00:00:00.000Z"),
      pendingInput: {
        kind: "side-effect-review",
        message: "Review the interrupted operation.",
      },
      status: "needs-review",
    });

    await expect(store.startEpoch("in-flight")).rejects.toThrow("in-flight operations");
    await expect(store.startEpoch("pending-review")).rejects.toThrow("pending review");
    await store.close();
  });

  it("removes only one session and all of its persisted artifacts", async () => {
    const directory = await temporaryDirectory();
    const store = new SessionStore({ sessionsDir: directory });
    const initial = state("session-1", "/workspace", "2026-08-01T00:00:00.000Z");
    await store.create(initial);
    await store.create(state("session-2", "/workspace", "2026-08-01T00:00:00.000Z"));
    const artifactPaths = [
      join(directory, initial.eventLogPath),
      join(directory, "session-1.transcript.jsonl"),
      join(directory, "session-1.jsonl"),
      store.leaseFilePath("session-1"),
    ];
    await Promise.all(artifactPaths.map((path) => writeFile(path, "persisted\n")));

    await store.remove("session-1");

    await expect(store.load("session-1")).rejects.toMatchObject({ code: "ENOENT" });
    for (const path of artifactPaths) {
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(store.load("session-2")).resolves.toMatchObject({ sessionId: "session-2" });
    await store.close();
  });

  it("rejects removing a held lease or an event log outside the Sessions directory", async () => {
    const directory = await temporaryDirectory();
    const store = new SessionStore({
      heartbeatIntervalMs: 0,
      sessionsDir: directory,
    });
    await store.create(state("held", "/workspace", "2026-08-01T00:00:00.000Z"));
    await store.acquireLease("held");

    await expect(store.remove("held")).rejects.toThrow("held Session lease");
    await expect(store.load("held")).resolves.toMatchObject({ sessionId: "held" });
    await store.close();

    const unsafeStore = new SessionStore({ sessionsDir: directory });
    await unsafeStore.create({
      ...state("unsafe", "/workspace", "2026-08-01T00:00:00.000Z"),
      eventLogPath: "../outside.events.jsonl",
    });
    const outsidePath = join(directory, "../outside.events.jsonl");
    await writeFile(outsidePath, "outside\n");

    await expect(unsafeStore.remove("unsafe")).rejects.toThrow(
      "must stay within the Sessions directory",
    );
    await expect(readFile(outsidePath, "utf8")).resolves.toBe("outside\n");
    await expect(unsafeStore.load("unsafe")).resolves.toMatchObject({ sessionId: "unsafe" });
    await unsafeStore.close();
    await rm(outsidePath, { force: true });
  });

  it("lists all workspace sessions while retaining the resumable filter", async () => {
    const directory = await temporaryDirectory();
    const store = new SessionStore({ sessionsDir: directory });
    await store.create(state("older", "/workspace", "2026-08-01T00:00:00.000Z"));
    await store.create({
      ...state("newer", "/workspace", "2026-08-01T00:00:02.000Z"),
      status: "needs-review",
    });
    await store.create({
      ...state("completed", "/workspace", "2026-08-01T00:00:03.000Z"),
      status: "completed",
    });
    await store.create({
      ...state("failed", "/workspace", "2026-08-01T00:00:05.000Z"),
      status: "failed",
    });
    await store.create(state("other", "/other", "2026-08-01T00:00:04.000Z"));

    await expect(store.list("/workspace")).resolves.toEqual([
      expect.objectContaining({ sessionId: "failed" }),
      expect.objectContaining({ sessionId: "completed" }),
      expect.objectContaining({ sessionId: "newer" }),
      expect.objectContaining({ sessionId: "older" }),
    ]);
    await expect(store.listResumable("/workspace")).resolves.toEqual([
      expect.objectContaining({ sessionId: "newer" }),
      expect.objectContaining({ sessionId: "older" }),
    ]);
    await store.close();
  });

  it("rejects damaged states and skips only valid unrelated states", async () => {
    const directory = await temporaryDirectory();
    const store = new SessionStore({ sessionsDir: directory });
    await store.create(state("valid", "/workspace", "2026-08-01T00:00:00.000Z"));
    await store.create(state("unrelated", "/other", "2026-08-01T00:00:01.000Z"));

    await expect(store.list("/workspace")).resolves.toEqual([
      expect.objectContaining({ sessionId: "valid" }),
    ]);

    const malformedPath = join(directory, "malformed.state.json");
    await writeFile(malformedPath, "{not-json");
    await expect(store.list("/workspace")).rejects.toBeInstanceOf(SyntaxError);
    await expect(store.listResumable("/workspace")).rejects.toBeInstanceOf(SyntaxError);
    await rm(malformedPath);

    await writeFile(
      join(directory, "invalid.state.json"),
      `${JSON.stringify({ invalid: true, workspaceDir: "/other" })}\n`,
    );
    await expect(store.list("/workspace")).rejects.toThrow();
    await expect(store.listResumable("/workspace")).rejects.toThrow();
    await store.close();
  });

  it("recovers dead local leases and rejects active or remote leases", async () => {
    const directory = await temporaryDirectory();
    const store = new SessionStore({
      hostname: "local",
      pid: 100,
      processExists: (pid) => pid === 200,
      sessionsDir: directory,
    });
    await mkdir(directory, { recursive: true });

    await writeLease(store.leaseFilePath("dead"), {
      heartbeatAt: "2026-08-01T00:00:00.000Z",
      hostname: "local",
      pid: 300,
      sessionId: "dead",
    });
    await expect(store.acquireLease("dead")).resolves.toBeUndefined();

    await writeLease(store.leaseFilePath("active"), {
      heartbeatAt: "2026-08-01T00:00:00.000Z",
      hostname: "local",
      pid: 200,
      sessionId: "active",
    });
    await expect(store.acquireLease("active")).rejects.toThrow("active Session lease");

    await writeLease(store.leaseFilePath("remote"), {
      heartbeatAt: "2026-08-01T00:00:00.000Z",
      hostname: "remote",
      pid: 400,
      sessionId: "remote",
    });
    await expect(store.acquireLease("remote")).rejects.toThrow("remote Session lease");

    await store.close();
    await expect(stat(store.leaseFilePath("dead"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates directories, IDs, duplicate states, size, and closed access", async () => {
    expect(() => new SessionStore({ sessionsDir: "relative" })).toThrow("must be absolute");
    const directory = await temporaryDirectory();
    const missing = new SessionStore({
      sessionsDir: join(directory, "missing"),
    });
    await expect(missing.list("/workspace")).resolves.toEqual([]);
    await expect(missing.listResumable("/workspace")).resolves.toEqual([]);
    await missing.close();

    const store = new SessionStore({
      maxStateBytes: 1_000,
      sessionsDir: directory,
    });
    expect(() => store.stateFilePath("../escape")).toThrow("unsupported characters");
    expect(() => store.leaseFilePath(" ")).toThrow("unsupported characters");
    await store.create(state("duplicate", "/workspace", "2026-08-01T00:00:00.000Z"));
    await expect(
      store.create(state("duplicate", "/workspace", "2026-08-01T00:00:00.000Z")),
    ).rejects.toThrow("already exists");
    await expect(
      store.create({
        ...state("large", "/workspace", "2026-08-01T00:00:00.000Z"),
        history: {
          entries: [{ content: "x".repeat(2_000), role: "user" }],
        },
      }),
    ).rejects.toThrow("exceeds 1000 bytes");
    await store.close();
    await store.close();
    await expect(store.load("duplicate")).rejects.toThrow("closed");
  });

  it("force-acquires remote leases, validates lease data, and starts heartbeats", async () => {
    const directory = await temporaryDirectory();
    const store = new SessionStore({
      heartbeatIntervalMs: 10,
      hostname: "local",
      pid: 100,
      sessionsDir: directory,
    });
    await mkdir(directory, { recursive: true });
    await writeLease(store.leaseFilePath("remote"), {
      heartbeatAt: "2026-08-01T00:00:00.000Z",
      hostname: "remote",
      pid: 400,
      sessionId: "remote",
    });

    await expect(store.acquireLease("remote", { force: true })).resolves.toBeUndefined();
    await expect(store.acquireLease("remote")).resolves.toBeUndefined();

    await writeFile(store.leaseFilePath("invalid"), "{}\n");
    await expect(store.acquireLease("invalid")).rejects.toThrow("lease is invalid");
    await store.close();
  });
});

function state(sessionId: string, workspaceDir: string, now: string) {
  return createInitialSessionState({
    agentKey: "code",
    configFingerprint: "config-v1",
    modelKey: "default",
    now,
    sessionId,
    workspaceDir,
  });
}

async function writeLease(
  path: string,
  lease: {
    readonly heartbeatAt: string;
    readonly hostname: string;
    readonly pid: number;
    readonly sessionId: string;
  },
): Promise<void> {
  await writeFile(path, `${JSON.stringify(lease)}\n`, { mode: 0o600 });
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "yiku-session-store-"));
  temporaryDirectories.push(directory);
  return directory;
}
