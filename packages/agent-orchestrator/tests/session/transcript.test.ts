import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookDecision } from "@yiku/hooks";
import { afterEach, describe, expect, it } from "vitest";
import { SessionTranscript } from "../../src/session/transcript.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("SessionTranscript", () => {
  it("serializes concurrent messages and Hook summaries in order", async () => {
    const directory = await temporaryDirectory();
    const filePath = join(directory, "session", "transcript.jsonl");
    const transcript = new SessionTranscript({
      clock: () => new Date("2026-08-01T00:00:00.000Z"),
      filePath,
    });

    await Promise.all([
      transcript.recordMessage("user", "first"),
      transcript.recordHook("Stop", decision()),
      transcript.recordMessage("assistant", "last"),
    ]);
    await transcript.close();

    const entries = (await readFile(filePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries).toEqual([
      expect.objectContaining({ content: "first", sequence: 1 }),
      expect.objectContaining({ action: "block", eventName: "Stop", sequence: 2 }),
      expect.objectContaining({ content: "last", sequence: 3 }),
    ]);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("closes idempotently and rejects later writes", async () => {
    const directory = await temporaryDirectory();
    const transcript = new SessionTranscript({
      filePath: join(directory, "transcript.jsonl"),
    });

    await transcript.close();
    await transcript.close();

    await expect(transcript.recordMessage("user", "late")).rejects.toThrow("closed");
  });

  it("requires an absolute path", () => {
    expect(() => new SessionTranscript({ filePath: "relative.jsonl" })).toThrow("absolute");
  });
});

function decision(): HookDecision {
  return {
    action: "block",
    additionalContext: [],
    diagnostics: [],
    permissionUpdates: [],
    reasons: ["tests missing"],
    suppressOutput: false,
    systemMessages: [],
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "yiku-session-transcript-"));
  temporaryDirectories.push(directory);
  return directory;
}
