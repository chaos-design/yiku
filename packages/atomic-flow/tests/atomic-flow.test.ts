import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AtomicFlowError,
  AtomicFlowRun,
  AtomicJsonlSink,
  foldAtomicEvents,
  readAtomicFlowEvents,
} from "../src/index.js";
import type { AtomicDefinition, AtomicFlowEvent, AtomicFlowSink } from "../src/types.js";

const tempDirs: string[] = [];
const atom: AtomicDefinition = {
  key: "loop.turn",
  kind: "loop",
  label: "Loop Turn",
  level: "runtime",
};

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("AtomicFlowRun", () => {
  it("emits ordered span events, edges, subscriptions, and bounded snapshots", () => {
    let id = 0;
    const nextId = (prefix: string) => {
      id += 1;
      return `${prefix}-${id}`;
    };
    const subscriber = vi.fn();
    const flow = new AtomicFlowRun({
      clock: () => new Date("2026-07-31T00:00:00.000Z"),
      eventIdGenerator: () => nextId("event"),
      instanceIdGenerator: () => nextId("instance"),
      maxBufferedEvents: 3,
      runId: "run-1",
    });
    const unsubscribe = flow.subscribe(subscriber);
    flow.subscribe(() => {
      throw new Error("observer failure");
    });
    const span = flow.start({
      atom,
      edge: {
        fromAtomKey: "input.prompt",
        kind: "execution",
        toAtomKey: atom.key,
      },
      iteration: 1,
      parentInstanceId: "run-instance",
    });
    span.delta({ summary: "working" });
    span.end({ durationMs: 10 });
    const scheduled = flow.schedule({
      atom: {
        key: "reply.final",
        kind: "reply",
        label: "Final Reply",
        level: "runtime",
      },
    });
    unsubscribe();

    expect(span.instanceId).toBe("instance-1");
    expect(subscriber).toHaveBeenCalledTimes(4);
    expect(scheduled.sequence).toBe(4);
    expect(flow.snapshot()).toMatchObject({
      degraded: false,
      events: [
        expect.objectContaining({ phase: "delta", sequence: 2 }),
        expect.objectContaining({ phase: "end", sequence: 3 }),
        expect.objectContaining({ phase: "scheduled", sequence: 4 }),
      ],
      runId: "run-1",
    });
  });

  it("supports failed and skipped spans and rejects duplicate completion", () => {
    const flow = new AtomicFlowRun({ runId: "run" });
    const failed = flow.start({ atom });
    failed.fail({ code: "FAILED" });
    const skipped = flow.start({ atom });
    skipped.skip();

    expect(() => failed.end()).toThrow("already ended");
    expect(flow.snapshot().events.map((event) => event.phase)).toEqual([
      "start",
      "error",
      "start",
      "skipped",
    ]);
  });

  it("records Hook atoms as first-class runtime spans", () => {
    const flow = new AtomicFlowRun({ runId: "run" });
    flow
      .start({
        atom: {
          key: "hook.execute",
          kind: "hook",
          label: "PreToolUse",
          level: "runtime",
        },
      })
      .end();

    expect(flow.snapshot().events.map((event) => event.atom.kind)).toEqual(["hook", "hook"]);
  });

  it("validates run, sink, atom, edge, and iteration inputs", () => {
    expect(() => new AtomicFlowRun({ runId: "" })).toThrow(AtomicFlowError);
    expect(() => new AtomicFlowRun({ maxBufferedEvents: 0, runId: "run" })).toThrow(
      "positive integer",
    );
    expect(
      () =>
        new AtomicFlowRun({
          runId: "run",
          sinks: [
            { id: "same", write() {} },
            { id: "same", write() {} },
          ],
        }),
    ).toThrow("Duplicate");

    const flow = new AtomicFlowRun({ runId: "run" });
    expect(() =>
      flow.emit({
        atom: { ...atom, key: "" },
        instance: { id: "instance" },
        phase: "start",
      }),
    ).toThrow("Atomic key");
    expect(() => flow.start({ atom, iteration: 0 })).toThrow("positive integer");
    expect(() =>
      flow.emit({
        atom,
        edge: {
          fromAtomKey: "",
          kind: "execution",
          toAtomKey: "target",
        },
        instance: { id: "instance" },
        phase: "start",
      }),
    ).toThrow("edge source");
  });

  it("isolates sink failures and records one-level receipts", async () => {
    const written: AtomicFlowEvent[] = [];
    const receiptSink: AtomicFlowSink = {
      id: "receipt",
      write(event) {
        written.push(event);
        return event.internal
          ? undefined
          : {
              atom: {
                key: "trace.append",
                kind: "trace",
                label: "Trace Append",
                level: "runtime",
              },
            };
      },
    };
    const failingSink: AtomicFlowSink = {
      id: "broken sink",
      write() {
        throw new Error("sink offline");
      },
    };
    const flow = new AtomicFlowRun({
      runId: "run",
      sinks: [receiptSink, failingSink],
      trace: true,
    });

    flow.start({ atom }).end();
    await flow.flush();

    expect(written.some((event) => event.atom.key === "trace.append")).toBe(true);
    expect(written.filter((event) => event.atom.key === "trace.append")).toHaveLength(2);
    expect(flow.snapshot()).toMatchObject({
      degraded: true,
      degradationCodes: ["ATOMIC_SINK_BROKEN_SINK"],
    });
    expect(flow.snapshot().events.some((event) => event.atom.key === "flow.sink-error")).toBe(true);
  });

  it("suppresses Trace receipts by default while preserving sink degradation", async () => {
    const receiptSink: AtomicFlowSink = {
      id: "receipt",
      write(event) {
        return event.internal
          ? undefined
          : {
              atom: {
                key: "trajectory.project",
                kind: "trajectory",
                label: "Trajectory Project",
                level: "runtime",
              },
            };
      },
    };
    const flow = new AtomicFlowRun({
      runId: "run",
      sinks: [
        receiptSink,
        {
          id: "broken",
          write() {
            throw new Error("offline");
          },
        },
      ],
    });

    flow.start({ atom }).end();
    await flow.flush();

    expect(flow.snapshot()).toMatchObject({
      degraded: true,
      degradationCodes: ["ATOMIC_SINK_BROKEN"],
    });
    expect(
      flow
        .snapshot()
        .events.some((event) => event.atom.kind === "trace" || event.atom.kind === "trajectory"),
    ).toBe(false);
  });

  it("closes sinks idempotently and rejects later events", async () => {
    const close = vi.fn();
    const flow = new AtomicFlowRun({
      runId: "run",
      sinks: [{ close, id: "sink", write() {} }],
    });
    flow.emit({
      atom,
      instance: { id: "instance" },
      phase: "start",
    });

    await flow.close();
    await flow.close();

    expect(close).toHaveBeenCalledOnce();
    expect(() =>
      flow.emit({
        atom,
        instance: { id: "later" },
        phase: "start",
      }),
    ).toThrow("closed");
  });
});

describe("foldAtomicEvents", () => {
  it("folds statuses, parents, iterations, errors, and edges through a sequence", () => {
    const flow = new AtomicFlowRun({
      clock: () => new Date("2026-07-31T00:00:00.000Z"),
      runId: "run",
    });
    const span = flow.start({
      atom,
      edge: {
        fromAtomKey: "input.prompt",
        fromInstanceId: "input-1",
        kind: "execution",
        toAtomKey: atom.key,
      },
      instanceId: "turn-1",
      iteration: 1,
      parentInstanceId: "run-1",
    });
    span.delta();
    span.fail({ code: "TURN_FAILED" });

    const throughTwo = foldAtomicEvents(flow.snapshot().events, 2);
    expect(throughTwo.instances.get("turn-1")).toMatchObject({
      iteration: 1,
      lastSequence: 2,
      parentId: "run-1",
      status: "running",
    });

    const complete = foldAtomicEvents(flow.snapshot().events);
    expect(complete.instances.get("turn-1")).toMatchObject({
      errorCode: "TURN_FAILED",
      status: "failed",
    });
    expect(complete.edges).toHaveLength(1);
  });

  it("rejects sequence and run conflicts", () => {
    const flow = new AtomicFlowRun({ runId: "run-a" });
    const event = flow.emit({
      atom,
      instance: { id: "instance" },
      phase: "start",
    });

    expect(() => foldAtomicEvents([event, event])).toThrow("strictly increasing");
    expect(() =>
      foldAtomicEvents([
        event,
        {
          ...event,
          eventId: "other",
          runId: "run-b",
          sequence: 2,
        },
      ]),
    ).toThrow("different runs");
  });
});

describe("AtomicJsonlSink", () => {
  it("persists every phase but projects trace receipts only for terminal events", async () => {
    const filePath = join(createTempDir(), "terminal-flow.jsonl");
    const source = new AtomicFlowRun({ runId: "terminal-run" });
    source.schedule({ atom, instanceId: "scheduled" });
    const completed = source.start({ atom, instanceId: "completed" });
    completed.delta();
    completed.end();
    source.start({ atom, instanceId: "failed" }).fail();
    source.start({ atom, instanceId: "skipped" }).skip();
    const events = source.snapshot().events;
    const sink = new AtomicJsonlSink({ filePath });
    const receipts: Array<Awaited<ReturnType<AtomicJsonlSink["write"]>>> = [];

    for (const event of events) {
      receipts.push(await sink.write(event));
    }

    await expect(readAtomicFlowEvents(filePath)).resolves.toEqual(events);
    expect(
      events.flatMap((event, index) => (receipts[index] === undefined ? [] : [event.phase])),
    ).toEqual(["end", "error", "skipped"]);
  });

  it("persists source events and receipts and supports sequence filtering", async () => {
    const filePath = join(createTempDir(), "flow.jsonl");
    const flow = new AtomicFlowRun({
      runId: "run",
      sinks: [new AtomicJsonlSink({ filePath })],
      trace: true,
    });
    flow.start({ atom }).end();
    await flow.close();

    const events = await readAtomicFlowEvents(filePath);
    expect(events.map((event) => event.atom.key)).toEqual([
      "loop.turn",
      "loop.turn",
      "trace.append",
    ]);
    await expect(readAtomicFlowEvents(filePath, { afterSequence: 2 })).resolves.toHaveLength(1);
    expect(readFileSync(filePath, "utf8").endsWith("\n")).toBe(true);
  });

  it("can omit internal receipts", async () => {
    const filePath = join(createTempDir(), "flow.jsonl");
    const flow = new AtomicFlowRun({
      runId: "run",
      sinks: [new AtomicJsonlSink({ filePath, includeReceipts: false })],
      trace: true,
    });
    flow.start({ atom }).end();
    await flow.close();

    await expect(readAtomicFlowEvents(filePath)).resolves.toHaveLength(2);
  });

  it("ignores a truncated final line and rejects malformed complete lines", async () => {
    const directory = createTempDir();
    const filePath = join(directory, "flow.jsonl");
    const flow = new AtomicFlowRun({ runId: "run" });
    const event = flow.emit({
      atom,
      instance: { id: "instance" },
      phase: "start",
    });
    writeFileSync(filePath, `${JSON.stringify(event)}\n{"truncated"`);

    await expect(readAtomicFlowEvents(filePath)).resolves.toEqual([event]);
    writeFileSync(filePath, `${JSON.stringify(event)}\nnot-json\n`);
    await expect(readAtomicFlowEvents(filePath)).rejects.toThrow("line 2");
    writeFileSync(filePath, `${JSON.stringify(event)}\n${JSON.stringify(event)}\n`);
    await expect(readAtomicFlowEvents(filePath)).rejects.toThrow("invalid sequence");
  });

  it("handles missing files and invalid sink paths", async () => {
    await expect(readAtomicFlowEvents(join(createTempDir(), "missing.jsonl"))).resolves.toEqual([]);
    expect(() => new AtomicJsonlSink({ filePath: " " })).toThrow("path is required");
  });
});

function createTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "yiku-atomic-flow-"));
  tempDirs.push(directory);
  return directory;
}
