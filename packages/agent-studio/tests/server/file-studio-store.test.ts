import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileStudioStore } from "../../src/server/file-studio-store.js";
import type { StudioEvent, StudioRunSummary } from "../../src/types.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("FileStudioStore", () => {
  it("persists and restores runs with a custom codec", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "agent-studio-"));
    directories.push(rootDir);
    const event: StudioEvent = {
      eventId: "event-1",
      occurredAt: "2026-08-07T00:00:01.000Z",
      runId: "external/run",
      sequence: 1,
    };
    const run: StudioRunSummary = {
      createdAt: "2026-08-07T00:00:00.000Z",
      eventCount: 1,
      runId: event.runId,
      status: "running",
      title: "External run",
      updatedAt: event.occurredAt,
    };
    const options = {
      decodeRun: (value: unknown, events: readonly StudioEvent[]): StudioRunSummary => {
        const stored = value as { readonly label: string; readonly runId: string };
        return {
          ...run,
          eventCount: events.length,
          runId: stored.runId,
          title: stored.label,
        };
      },
      encodeRun: (value: StudioRunSummary) => ({
        label: value.title,
        runId: value.runId,
      }),
      rootDir,
    };
    const store = new FileStudioStore(options);
    await store.appendEvent(event);
    await store.writeRun(run);

    const restored = await new FileStudioStore(options).initialize();

    expect(restored).toEqual([{ events: [event], run }]);
    expect(readFileSync(join(rootDir, hashKey(event.runId), "run.json"), "utf8")).toContain(
      '"label": "External run"',
    );
  });

  it("ignores malformed storage directories", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "agent-studio-"));
    directories.push(rootDir);
    const store = new FileStudioStore({ rootDir });

    await expect(store.initialize()).resolves.toEqual([]);
  });

  it("uses the default codec and restores runs without an event file", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "agent-studio-"));
    directories.push(rootDir);
    const event: StudioEvent = {
      eventId: "event-1",
      occurredAt: "2026-08-07T00:00:01.000Z",
      runId: "run-1",
      sequence: 1,
    };
    const run: StudioRunSummary = {
      createdAt: "2026-08-07T00:00:00.000Z",
      eventCount: 1,
      metadata: { mode: "local" },
      runId: event.runId,
      status: "running",
      title: "Default run",
      updatedAt: event.occurredAt,
    };
    const store = new FileStudioStore({ rootDir });
    await store.appendEvent(event);
    await store.writeRun(run);
    await expect(new FileStudioStore({ rootDir }).initialize()).resolves.toEqual([
      { events: [event], run },
    ]);

    const secondDir = join(rootDir, hashKey("run-2"));
    mkdirSync(secondDir);
    writeFileSync(
      join(secondDir, "run.json"),
      JSON.stringify({
        ...run,
        eventCount: 99,
        runId: "run-2",
      }),
    );
    const restored = await new FileStudioStore({ rootDir }).initialize();
    expect(restored.find((entry) => entry.run.runId === "run-2")).toEqual({
      events: [],
      run: expect.objectContaining({ eventCount: 0, runId: "run-2" }),
    });
  });

  it("rejects unsafe file names, storage keys and malformed events", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "agent-studio-"));
    directories.push(rootDir);
    expect(() => new FileStudioStore({ eventsFileName: "../events", rootDir })).toThrow(
      "file name",
    );

    const unsafe = new FileStudioStore({
      rootDir,
      storageKey: () => "../outside",
    });
    await expect(
      unsafe.appendEvent({
        eventId: "event-1",
        occurredAt: "2026-08-07T00:00:01.000Z",
        runId: "run-1",
        sequence: 1,
      }),
    ).rejects.toThrow("storage key");

    const malformedDir = join(rootDir, "malformed");
    mkdirSync(malformedDir);
    writeFileSync(join(malformedDir, "events.jsonl"), "{}\n");
    writeFileSync(
      join(malformedDir, "run.json"),
      JSON.stringify({
        createdAt: "2026-08-07T00:00:00.000Z",
        runId: "run-bad",
        status: "running",
        title: "Bad",
        updatedAt: "2026-08-07T00:00:00.000Z",
      }),
    );
    await expect(new FileStudioStore({ rootDir }).initialize()).resolves.toEqual([]);
  });
});

function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
