import type { StudioRunSummary } from "@yiku/agent-studio";
import type { AtomicFlowEvent } from "@yiku/atomic-flow";
import { describe, expect, it } from "vitest";
import {
  AGENT_OBSERVATORY_SERVER_MANIFEST,
  agentObservatoryServerPlugin,
} from "../../server/plugin.js";
import { AGENT_OBSERVATORY_MANIFEST } from "../../src/plugin/manifest.js";

describe("agentObservatoryServerPlugin", () => {
  it("shares its manifest with the client and adapts Atomic Flow events", async () => {
    expect(AGENT_OBSERVATORY_SERVER_MANIFEST).toEqual(AGENT_OBSERVATORY_MANIFEST);
    const plugin = agentObservatoryServerPlugin();
    const adapter = plugin.adapters?.[0];
    const event = atomicEvent(1, "start");

    const adapted = await adapter?.parse({
      event,
      project: { name: "Example" },
      run: { kind: "control", prompt: "Inspect runtime" },
    });

    expect(adapted).toEqual({
      event,
      seed: expect.objectContaining({
        metadata: expect.objectContaining({
          kind: "control",
          projectName: "Example",
          source: "external",
        }),
        status: "running",
        title: "Inspect runtime",
      }),
    });
  });

  it("projects terminal status and excludes trace observations from counts", async () => {
    const projector = agentObservatoryServerPlugin().projectors?.[0];
    const first = atomicEvent(1, "start");
    const trace: AtomicFlowEvent = {
      ...atomicEvent(2, "end"),
      atom: {
        key: "trace.append",
        kind: "trace",
        label: "Trace",
        level: "runtime",
      },
    };
    const last = atomicEvent(3, "end");
    const current: StudioRunSummary = {
      createdAt: first.occurredAt,
      eventCount: 1,
      runId: first.runId,
      status: "running",
      title: "Run",
      updatedAt: first.occurredAt,
    };

    expect(
      await projector?.project({
        current,
        event: last,
        events: [first, trace, last],
      }),
    ).toEqual({
      eventCount: 2,
      status: "completed",
    });

    const reply: AtomicFlowEvent = {
      ...atomicEvent(4, "end"),
      atom: {
        key: "reply.final",
        kind: "reply",
        label: "Final Reply",
        level: "runtime",
      },
      instance: { id: "reply" },
      payload: {
        values: {
          output: "Completed output",
        },
      },
    };
    expect(
      await projector?.project({
        current: { ...current, status: "completed" },
        event: reply,
        events: [first, trace, last, reply],
      }),
    ).toEqual({
      eventCount: 3,
      metadata: {
        output: "Completed output",
      },
      status: "completed",
    });
  });
});

function atomicEvent(sequence: number, phase: "end" | "start"): AtomicFlowEvent {
  return {
    atom: {
      key: "run",
      kind: "input",
      label: "Run",
      level: "runtime",
    },
    eventId: `event-${sequence}`,
    instance: { id: "run" },
    occurredAt: `2026-08-07T00:00:0${sequence}.000Z`,
    phase,
    runId: "run-1",
    sequence,
  };
}
