import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AtomicFlowEvent, AtomicFlowRun } from "@yiku/atomic-flow";
import { afterEach, describe, expect, it } from "vitest";
import {
  AtomicTrajectorySink,
  type OperationEvent,
  readTraceEntries,
  renderTrajectoryMarkdown,
  renderTrajectoryMermaid,
  renderTrajectoryText,
  Trace,
  TrajectoryRecorder,
} from "../src/index.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("TrajectoryRecorder", () => {
  it("records ordered operation steps and updates completion data", () => {
    const recorder = new TrajectoryRecorder("session-1", "2026-07-31T00:00:00.000Z");

    recorder.record(operation({ name: "run", operationId: "run-1" }));
    recorder.record(
      operation({
        kind: "tool",
        name: "bashTool",
        operationId: "tool-1",
        parentId: "run-1",
      }),
    );
    recorder.record(
      operation({
        endedAt: "2026-07-31T00:00:01.000Z",
        kind: "tool",
        name: "bashTool",
        operationId: "tool-1",
        output: "passed",
        parentId: "run-1",
        phase: "end",
        status: "completed",
      }),
    );
    recorder.record(
      operation({
        endedAt: "2026-07-31T00:00:02.000Z",
        name: "run",
        operationId: "run-1",
        phase: "end",
        status: "completed",
      }),
    );

    expect(recorder.snapshot()).toEqual({
      endedAt: "2026-07-31T00:00:02.000Z",
      id: "session-1",
      startedAt: "2026-07-31T00:00:00.000Z",
      steps: [
        expect.objectContaining({
          id: "run-1",
          kind: "run",
          status: "completed",
        }),
        expect.objectContaining({
          id: "tool-1",
          kind: "tool",
          output: "passed",
          parentId: "run-1",
          status: "completed",
        }),
      ],
    });
  });

  it("projects atomic flow instances and iterations", async () => {
    const sink = new AtomicTrajectorySink("atomic", "2026-07-31T00:00:00.000Z");
    const flow = new AtomicFlowRun({
      clock: () => new Date("2026-07-31T00:00:01.000Z"),
      runId: "atomic",
      sinks: [sink],
      trace: true,
    });
    const span = flow.start({
      atom: {
        key: "loop.turn",
        kind: "loop",
        label: "Loop Turn",
        level: "runtime",
      },
      instanceId: "turn-1",
      iteration: 1,
    });
    span.end();
    await flow.flush();

    expect(sink.snapshot().steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          atomKey: "loop.turn",
          id: "turn-1",
          iteration: 1,
          kind: "loop",
          status: "completed",
        }),
        expect.objectContaining({
          atomKey: "trajectory.project",
          kind: "trajectory",
        }),
      ]),
    );
  });

  it("projects only terminal external events while retaining every trajectory step", () => {
    const sink = new AtomicTrajectorySink("terminal-projection");
    const phases = ["scheduled", "start", "delta", "end", "error", "skipped"] as const;
    const receipts = phases.map((phase, index) => sink.write(atomicEvent(phase, index + 1)));
    const internalReceipt = sink.write({
      ...atomicEvent("end", phases.length + 1),
      internal: true,
    });

    expect(receipts.map((receipt) => receipt !== undefined)).toEqual([
      false,
      false,
      false,
      true,
      true,
      true,
    ]);
    expect(internalReceipt).toBeUndefined();
    expect(sink.snapshot().steps).toHaveLength(phases.length + 1);
  });

  it("records Hook operation and Atomic kinds", () => {
    const recorder = new TrajectoryRecorder("hooks");
    recorder.record(
      operation({
        kind: "hook",
        name: "PreToolUse",
        operationId: "hook-1",
      }),
    );
    recorder.record(
      operation({
        endedAt: "2026-08-01T00:00:00.001Z",
        kind: "hook",
        name: "PreToolUse",
        operationId: "hook-1",
        phase: "end",
        status: "completed",
      }),
    );

    expect(recorder.snapshot().steps).toEqual([
      expect.objectContaining({
        id: "hook-1",
        kind: "hook",
        status: "completed",
      }),
    ]);
  });

  it("covers run errors and every Atomic status transition", () => {
    const recorder = new TrajectoryRecorder("status");
    recorder.record(
      operation({
        kind: "run",
        name: "run",
        operationId: "run-error",
        phase: "error",
        status: "failed",
      }),
    );
    const flow = new AtomicFlowRun({
      clock: () => new Date("2026-08-01T00:00:00.000Z"),
      runId: "status",
    });
    const running = flow.start({
      atom: {
        key: "run",
        kind: "input",
        label: "Run",
        level: "runtime",
      },
      instanceId: "atomic-run",
      iteration: 1,
      parentInstanceId: "parent",
      payload: { summary: "start" },
    });
    running.delta();
    running.fail();
    flow.schedule({
      atom: {
        key: "later",
        kind: "hook",
        label: "Later",
        level: "runtime",
      },
      instanceId: "scheduled",
    });
    const skipped = flow.start({
      atom: {
        key: "skip",
        kind: "hook",
        label: "Skip",
        level: "runtime",
      },
      instanceId: "skipped",
    });
    skipped.skip();

    for (const event of flow.snapshot().events) {
      recorder.recordAtomic(event);
    }

    expect(recorder.snapshot()).toMatchObject({
      endedAt: "2026-08-01T00:00:00.000Z",
      steps: expect.arrayContaining([
        expect.objectContaining({ id: "atomic-run", status: "failed" }),
        expect.objectContaining({ id: "scheduled", status: "running" }),
        expect.objectContaining({ id: "skipped", status: "completed" }),
      ]),
    });
  });
});

describe("Trace", () => {
  it("writes append-only JSONL entries and resumes step numbers", () => {
    const traceFilePath = join(createTempDir(), "session.jsonl");

    new Trace(traceFilePath).record({
      prompt: "review this",
      type: "session_started",
    });
    new Trace(traceFilePath).record({
      output: "done",
      type: "session_finished",
    });

    const entries = readTraceEntries(traceFilePath);

    expect(entries.map((entry) => entry.step)).toEqual([1, 2]);
    expect(entries.map((entry) => entry.result)).toEqual(["review this", "done"]);
    expect(readFileSync(traceFilePath, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("supports custom result extraction", () => {
    const traceFilePath = join(createTempDir(), "custom.jsonl");
    const trace = new Trace<{ readonly value: string }>(traceFilePath, {
      getResult: (event) => event.value.toUpperCase(),
    });

    trace.record({ value: "ok" });

    expect(readTraceEntries(traceFilePath)[0]?.result).toBe("OK");
  });
});

describe("trajectory renderers", () => {
  it("renders text, markdown, and mermaid views", () => {
    const recorder = new TrajectoryRecorder("session-1", "2026-07-31T00:00:00.000Z");
    recorder.record(
      operation({
        endedAt: "2026-07-31T00:00:01.000Z",
        name: "run",
        operationId: "run-1",
        phase: "end",
        status: "completed",
      }),
    );
    const trajectory = recorder.snapshot();

    expect(renderTrajectoryText(trajectory)).toContain("Trajectory session-1");
    expect(renderTrajectoryMarkdown(trajectory)).toContain("# Trajectory session-1");
    expect(renderTrajectoryMermaid(trajectory)).toContain("flowchart TD");
  });

  it("renders raw values and empty mermaid diagrams", () => {
    const empty = {
      id: "empty",
      startedAt: "invalid",
      steps: [],
    };
    const recorder = new TrajectoryRecorder("session 2", "invalid");

    recorder.record(
      operation({
        error: "failed",
        input: {
          command: "pnpm test",
        },
        kind: "tool",
        name: "bash tool",
        operationId: "1-tool",
        output: "output",
        phase: "error",
        status: "failed",
      }),
    );
    const trajectory = recorder.snapshot();

    expect(renderTrajectoryMermaid(empty)).toContain("empty[No steps]");
    expect(renderTrajectoryText(trajectory, { includeRawValues: true })).toContain(
      'input: { "command": "pnpm test" }',
    );
    expect(renderTrajectoryMarkdown(trajectory, { includeRawValues: true })).toContain("Error:");
    expect(renderTrajectoryMermaid(trajectory)).toContain('step_1_tool["tool:bash tool failed"]');
  });

  it("renders parent links and circular raw values", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const trajectory = {
      id: "linked",
      startedAt: "2026-07-31T00:00:00.000Z",
      steps: [
        {
          id: "parent",
          kind: "run",
          name: "run",
          startedAt: "2026-07-31T00:00:00.000Z",
          status: "running",
        },
        {
          endedAt: "2026-07-31T00:00:01.000Z",
          id: "child",
          input: circular,
          kind: "tool",
          name: 'quote"tool',
          parentId: "parent",
          startedAt: "2026-07-31T00:00:00.000Z",
          status: "completed",
        },
      ],
    } as const;

    expect(renderTrajectoryMarkdown(trajectory, { includeRawValues: true })).toContain(
      "- Parent: parent",
    );
    expect(renderTrajectoryText(trajectory, { includeRawValues: true })).toContain(
      "input: [object Object]",
    );
    expect(renderTrajectoryMermaid(trajectory)).toContain("parent --> child");
    expect(renderTrajectoryMermaid(trajectory)).toContain('\\"tool');
  });
});

function operation(overrides: Partial<OperationEvent>): OperationEvent {
  return {
    kind: "run",
    name: "run",
    operationId: "operation-1",
    phase: "start",
    startedAt: "2026-07-31T00:00:00.000Z",
    status: "running",
    ...overrides,
  };
}

function atomicEvent(phase: AtomicFlowEvent["phase"], sequence: number): AtomicFlowEvent {
  return {
    atom: {
      key: `test.${sequence}`,
      kind: "loop",
      label: `Test ${sequence}`,
      level: "runtime",
    },
    eventId: `event-${sequence}`,
    instance: {
      id: `instance-${sequence}`,
    },
    occurredAt: "2026-08-05T00:00:00.000Z",
    phase,
    runId: "terminal-projection",
    sequence,
  };
}

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yiku-trajectory-"));
  tempDirs.push(dir);

  return dir;
}
