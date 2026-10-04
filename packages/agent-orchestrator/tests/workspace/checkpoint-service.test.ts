import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentMessageBus } from "../../src/messages/message-bus.js";
import type { AgentMessageEnvelope } from "../../src/messages/types.js";
import { CheckpointService } from "../../src/workspace/checkpoint-service.js";
import { WorkspaceSnapshotStore } from "../../src/workspace/workspace-snapshot-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("CheckpointService", () => {
  it("creates, lists, publishes, and reuses the current turn checkpoint", async () => {
    const fixture = await createFixture();
    const messages: AgentMessageEnvelope[] = [];
    const times = [new Date("2026-08-10T00:00:01.000Z"), new Date("2026-08-10T00:00:02.000Z")];
    const service = new CheckpointService({
      clock: () => times.shift() ?? new Date("2026-08-10T00:00:03.000Z"),
      indexFilePath: fixture.indexFilePath,
      messageBus: new AgentMessageBus({
        sinks: [
          {
            kind: "required",
            publish: (message) => messages.push(message),
          },
        ],
      }),
      sessionId: "session-1",
      snapshotStore: fixture.snapshotStore,
    });
    const history = [{ content: "original", role: "user" as const }];

    const creating = service.beforeTurn({
      eventHead: "event-1",
      historyEntries: history,
      prompt: "first prompt",
      sessionRevision: 3,
    });
    const originalHistoryEntry = history[0];
    if (originalHistoryEntry === undefined) {
      throw new Error("Expected checkpoint history fixture.");
    }
    originalHistoryEntry.content = "mutated";
    const first = await creating;
    const reused = await service.beforeTool();
    await writeFile(join(fixture.workspaceDir, "file.txt"), "second");
    const second = await service.beforeTurn({
      historyEntries: [{ content: "assistant reply", role: "assistant" }],
      prompt: "second prompt",
      sessionRevision: 4,
    });

    expect(reused).toBe(first);
    expect(await readdir(join(fixture.snapshotStorageDir, "manifests"))).toHaveLength(2);
    await expect(service.list()).resolves.toEqual([
      {
        createdAt: "2026-08-10T00:00:01.000Z",
        eventHead: "event-1",
        fileCount: 1,
        historyEntries: [{ content: "original", role: "user" }],
        id: first.id,
        prompt: "first prompt",
        sessionRevision: 3,
        totalBytes: 7,
      },
      {
        createdAt: "2026-08-10T00:00:02.000Z",
        fileCount: 1,
        historyEntries: [{ content: "assistant reply", role: "assistant" }],
        id: second.id,
        prompt: "second prompt",
        sessionRevision: 4,
        totalBytes: 6,
      },
    ]);
    expect(JSON.parse(await readFile(fixture.indexFilePath, "utf8"))).toEqual(await service.list());
    expect((await stat(fixture.indexFilePath)).mode & 0o777).toBe(0o600);
    expect(messages.map((message) => message.payload)).toEqual([
      { action: "created", checkpointId: first.id, kind: "checkpoint" },
      { action: "created", checkpointId: second.id, kind: "checkpoint" },
    ]);
  });

  it("restores an indexed checkpoint and publishes the restoration", async () => {
    const fixture = await createFixture();
    const messages: AgentMessageEnvelope[] = [];
    const service = new CheckpointService({
      clock: () => new Date("2026-08-10T01:00:00.000Z"),
      indexFilePath: fixture.indexFilePath,
      messageBus: new AgentMessageBus({
        sinks: [
          {
            kind: "required",
            publish: (message) => messages.push(message),
          },
        ],
      }),
      sessionId: "session-1",
      snapshotStore: fixture.snapshotStore,
    });
    const checkpoint = await service.beforeTurn({
      historyEntries: [],
      prompt: "preserve workspace",
      sessionRevision: 1,
    });
    await writeFile(join(fixture.workspaceDir, "file.txt"), "changed");
    await writeFile(join(fixture.workspaceDir, "extra.txt"), "remove me");

    await expect(service.restore(checkpoint.id)).resolves.toEqual(checkpoint);

    await expect(readFile(join(fixture.workspaceDir, "file.txt"), "utf8")).resolves.toBe("initial");
    await expect(readFile(join(fixture.workspaceDir, "extra.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(messages.map((message) => message.payload)).toEqual([
      { action: "created", checkpointId: checkpoint.id, kind: "checkpoint" },
      { action: "restored", checkpointId: checkpoint.id, kind: "checkpoint" },
    ]);
  });

  it("requires an absolute index path and a started turn before tool capture", async () => {
    const fixture = await createFixture();
    expect(
      () =>
        new CheckpointService({
          indexFilePath: "relative.json",
          sessionId: "session-1",
          snapshotStore: fixture.snapshotStore,
        }),
    ).toThrow(/absolute/u);

    const service = new CheckpointService({
      indexFilePath: fixture.indexFilePath,
      sessionId: "session-1",
      snapshotStore: fixture.snapshotStore,
    });
    await expect(service.beforeTool()).rejects.toThrow(/turn has started/u);
    expect(() =>
      service.beforeTurn({
        historyEntries: [],
        prompt: "invalid",
        sessionRevision: -1,
      }),
    ).toThrow(/revision/u);
    expect(
      () =>
        new CheckpointService({
          indexFilePath: fixture.indexFilePath,
          sessionId: "",
          snapshotStore: fixture.snapshotStore,
        }),
    ).toThrow(/Session ID/u);
  });

  it("rejects corrupt indexes, invalid records, and unknown checkpoints", async () => {
    const fixture = await createFixture();
    const service = new CheckpointService({
      indexFilePath: fixture.indexFilePath,
      sessionId: "session-1",
      snapshotStore: fixture.snapshotStore,
    });
    await mkdir(join(fixture.indexFilePath, ".."), { recursive: true });

    for (const value of [
      {},
      [null],
      [
        {
          createdAt: "invalid",
          historyEntries: [],
          id: "checkpoint",
          prompt: "prompt",
          sessionRevision: 1,
        },
      ],
      [
        {
          createdAt: "2026-08-10T00:00:00.000Z",
          eventHead: 1,
          historyEntries: [],
          id: "checkpoint",
          prompt: "prompt",
          sessionRevision: 1,
        },
      ],
      [
        {
          createdAt: "2026-08-10T00:00:00.000Z",
          fileCount: -1,
          historyEntries: [],
          id: "checkpoint",
          prompt: "prompt",
          sessionRevision: 1,
        },
      ],
      [
        {
          createdAt: "2026-08-10T00:00:00.000Z",
          historyEntries: [{ content: "bad", role: "tool" }],
          id: "checkpoint",
          prompt: "prompt",
          sessionRevision: 1,
        },
      ],
    ]) {
      await writeFile(fixture.indexFilePath, JSON.stringify(value));
      await expect(service.list()).rejects.toThrow(/Checkpoint/u);
    }

    await writeFile(fixture.indexFilePath, "[]");
    await expect(service.restore("missing")).rejects.toThrow("not indexed");
  });
});

interface Fixture {
  readonly indexFilePath: string;
  readonly snapshotStorageDir: string;
  readonly snapshotStore: WorkspaceSnapshotStore;
  readonly workspaceDir: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "yiku-checkpoint-service-"));
  temporaryDirectories.push(root);
  const workspaceDir = join(root, "workspace");
  const snapshotStorageDir = join(root, "snapshots");
  await mkdir(workspaceDir);
  await writeFile(join(workspaceDir, "file.txt"), "initial");
  return {
    indexFilePath: join(root, "index", "checkpoints.json"),
    snapshotStorageDir,
    snapshotStore: new WorkspaceSnapshotStore({
      storageDir: snapshotStorageDir,
      workspaceDir,
    }),
    workspaceDir,
  };
}
