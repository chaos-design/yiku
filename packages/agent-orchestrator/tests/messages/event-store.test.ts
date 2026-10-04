import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEventStore } from "../../src/messages/event-store.js";
import type { AgentMessageEnvelope } from "../../src/messages/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("AgentEventStore", () => {
  it("requires an absolute file path", () => {
    expect(() => new AgentEventStore({ filePath: "events/session.events.jsonl" })).toThrow(
      "Agent event store file path must be absolute.",
    );
  });

  it("snapshots one JSON envelope per line and flushes before close", async () => {
    const filePath = await eventLogPath();
    const store = new AgentEventStore({ filePath });
    const firstMessage = envelope("root", 1);
    const secondMessage = envelope("child", 2);
    const mutablePayload = firstMessage.payload as {
      values: { sequence: number };
    };

    const first = store.publish(firstMessage);
    const second = store.publish(secondMessage);
    mutablePayload.values.sequence = 99;
    expect(Object.isFrozen(firstMessage)).toBe(false);

    await expect(store.close()).resolves.toBeUndefined();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);

    const records = (await readFile(filePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as AgentMessageEnvelope);
    expect(records).toEqual([envelope("root", 1), envelope("child", 2)]);
  });

  it("creates a private directory and append file", async () => {
    const filePath = await eventLogPath();
    const store = new AgentEventStore({ filePath });

    await store.publish(envelope("root", 1));
    await store.close();

    expect((await stat(dirname(filePath))).mode & 0o777).toBe(0o700);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("rejects publication after close", async () => {
    const store = new AgentEventStore({ filePath: await eventLogPath() });
    await store.close();

    await expect(store.publish(envelope("root", 1))).rejects.toThrow(
      "Agent event store is closed.",
    );
  });

  it("recovers its queue after an append cannot be opened", async () => {
    const filePath = await eventLogPath();
    await mkdir(dirname(filePath), { recursive: true });
    await mkdir(filePath);
    const store = new AgentEventStore({ filePath });

    await expect(store.publish(envelope("root", 1))).rejects.toThrow();
    await rm(filePath, { recursive: true });
    await expect(store.publish(envelope("root", 2))).resolves.toBeUndefined();
    await store.close();

    const records = (await readFile(filePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as AgentMessageEnvelope);
    expect(records.map((record) => record.eventId)).toEqual(["event-2"]);
  });

  it("closes through AsyncDisposable", async () => {
    const store = new AgentEventStore({ filePath: await eventLogPath() });
    const publication = store.publish(envelope("root", 1));

    await expect(store[Symbol.asyncDispose]()).resolves.toBeUndefined();
    await expect(publication).resolves.toBeUndefined();
    await expect(store.publish(envelope("root", 2))).rejects.toThrow(
      "Agent event store is closed.",
    );
  });
});

function envelope(agentId: string, sequence: number): AgentMessageEnvelope {
  return {
    agentId,
    eventId: `event-${sequence}`,
    occurredAt: "2026-08-10T00:00:00.000Z",
    payload: {
      kind: "session_lifecycle",
      phase: "running",
      values: { sequence },
    },
    sessionId: "session-1",
  };
}

async function eventLogPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yiku-agent-events-"));
  temporaryDirectories.push(root);
  return join(root, "private", "session.events.jsonl");
}
