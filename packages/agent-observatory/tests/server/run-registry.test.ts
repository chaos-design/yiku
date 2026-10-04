import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AtomicFlowEvent, AtomicValue } from "@yiku/atomic-flow";
import { YikuPaths } from "@yiku/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunRegistry } from "../../server/run-registry.js";

const directories: string[] = [];
const registries: RunRegistry[] = [];

afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.close()));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("RunRegistry external ingestion", () => {
  it("broadcasts, persists, safely maps, and reloads external runs", async () => {
    const workspaceDir = createTempDir();
    const homeDir = createTempDir();
    const firstRegistry = new RunRegistry({ homeDir, workspaceDir });
    registries.push(firstRegistry);
    await firstRegistry.initialize();
    const first = atomicEvent(1, "start");

    await expect(
      firstRegistry.ingest({
        event: first,
        project: {
          name: "External Project",
        },
        run: {
          kind: "control",
          prompt: "Inspect the flow",
          sessionId: "session-1",
        },
      }),
    ).resolves.toMatchObject({
      duplicate: false,
      expectedSequence: 2,
    });

    const listener = vi.fn();
    const unsubscribe = firstRegistry.subscribe(first.runId, listener);
    const second = atomicEvent(2, "end");
    await firstRegistry.ingest({ event: second });
    expect(listener).toHaveBeenCalledWith(second);
    const third = replyEvent(3, { completed: true });
    await firstRegistry.ingest({ event: third });
    expect(listener).toHaveBeenCalledWith(third);
    unsubscribe?.();

    const storageEntries = readdirSync(new YikuPaths({ homeDir, workspaceDir }).runsDir);
    expect(storageEntries).toEqual([expect.stringMatching(/^external-[a-f0-9]{64}$/u)]);

    await firstRegistry.close();
    registries.splice(registries.indexOf(firstRegistry), 1);

    const secondRegistry = new RunRegistry({ homeDir, workspaceDir });
    registries.push(secondRegistry);
    await secondRegistry.initialize();

    await expect(secondRegistry.get(first.runId)).resolves.toMatchObject({
      eventCount: 3,
      events: [first, second, third],
      kind: "control",
      output: '{\n  "completed": true\n}',
      prompt: "Inspect the flow",
      projectName: "External Project",
      sessionId: "session-1",
      source: "external",
      status: "completed",
    });
  });

  it("projects blocking Eval events into scorecard and gate status", async () => {
    const registry = createRegistry();
    registries.push(registry);
    await registry.initialize();
    const events: AtomicFlowEvent[] = [
      atomicEvent(1, "start"),
      atomicEvent(2, "end"),
      evalEvent(3, "eval.trigger", "start"),
      evalEvent(4, "eval.flow-integrity", "end", {
        summary: "Flow is valid.",
        values: {
          passed: true,
          score: 1,
        },
      }),
      evalEvent(5, "eval.scorecard", "end", {
        values: {
          averageScore: 1,
          passed: true,
        },
      }),
      evalEvent(6, "eval.gate", "end", {
        summary: "accepted",
      }),
    ];

    for (const event of events) {
      await registry.ingest({ event });
    }

    await expect(registry.get(events[0]?.runId ?? "")).resolves.toMatchObject({
      evalMode: "blocking",
      scorecard: {
        averageScore: 1,
        passed: true,
        results: [
          {
            key: "flow-integrity",
            label: "Flow Integrity",
            passed: true,
            score: 1,
            summary: "Flow is valid.",
          },
        ],
      },
      status: "accepted",
    });
  });

  it("keeps raw Trace events while excluding them from functional event counts", async () => {
    const registry = createRegistry();
    registries.push(registry);
    await registry.initialize();
    const events: AtomicFlowEvent[] = [
      atomicEvent(1, "start"),
      {
        ...atomicEvent(2, "end"),
        atom: {
          key: "trace.append",
          kind: "trace",
          label: "Trace Append",
          level: "runtime",
        },
        internal: true,
      },
      atomicEvent(3, "end"),
    ];

    for (const event of events) {
      await registry.ingest({ event });
    }

    await expect(registry.list()).resolves.toMatchObject([
      {
        eventCount: 2,
      },
    ]);
    await expect(registry.get(events[0]?.runId ?? "")).resolves.toMatchObject({
      eventCount: 2,
      events,
    });
    await expect(registry.events(events[0]?.runId ?? "")).resolves.toEqual(events);
  });

  it("projects root and child Agent sessions without duplicating the parent Run", async () => {
    const registry = createRegistry();
    registries.push(registry);
    await registry.initialize();
    const events = [
      atomicEvent(1, "start"),
      subagentLifecycleEvent(2, "start"),
      subagentLifecycleEvent(3, "end"),
    ] as const;

    await registry.ingest({
      event: events[0],
      run: {
        agentKey: "code",
        agentName: "Code Agent",
        agentType: "code",
        prompt: "Review the repository",
        sessionId: "session-1",
      },
    });
    await registry.ingest({ event: events[1] });
    await registry.ingest({ event: events[2] });

    await expect(registry.list()).resolves.toHaveLength(1);
    await expect(registry.get(events[0].runId)).resolves.toMatchObject({
      agentKey: "code",
      agentName: "Code Agent",
      agentSessions: [
        {
          agentId: "child-1",
          agentName: "Reviewer",
          agentSessionId: "session-1.agent.child-1",
          agentType: "code",
          parentSessionId: "session-1",
          status: "succeeded",
          taskId: "task-1",
        },
      ],
      agentType: "code",
      eventCount: 3,
      events,
      sessionId: "session-1",
    });
  });
});

function createRegistry(): RunRegistry {
  return new RunRegistry({
    homeDir: createTempDir(),
    workspaceDir: createTempDir(),
  });
}

function atomicEvent(sequence: number, phase: "end" | "start"): AtomicFlowEvent {
  return {
    atom: {
      key: "run",
      kind: "input",
      label: "Run",
      level: "runtime",
    },
    eventId: `event-${sequence}`,
    instance: {
      id: "run-instance",
    },
    occurredAt: `2026-08-01T00:00:0${sequence}.000Z`,
    phase,
    runId: "external/project run",
    sequence,
  };
}

function replyEvent(sequence: number, output: AtomicValue): AtomicFlowEvent {
  return {
    ...atomicEvent(sequence, "end"),
    atom: {
      key: "reply.final",
      kind: "reply",
      label: "Final Reply",
      level: "runtime",
    },
    instance: {
      id: "reply-instance",
    },
    payload: {
      values: {
        output,
      },
    },
  };
}

function evalEvent(
  sequence: number,
  key: string,
  phase: "end" | "start",
  payload?: AtomicFlowEvent["payload"],
): AtomicFlowEvent {
  return {
    atom: {
      key,
      kind: key === "eval.gate" ? "release" : "eval",
      label: key
        .slice("eval.".length)
        .split("-")
        .map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
        .join(" "),
      level: "runtime",
    },
    eventId: `event-${sequence}`,
    instance: {
      id: `eval-${sequence}`,
    },
    occurredAt: `2026-08-01T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    ...(payload !== undefined ? { payload } : {}),
    phase,
    runId: "external/project run",
    sequence,
  };
}

function subagentLifecycleEvent(sequence: number, phase: "end" | "start"): AtomicFlowEvent {
  return {
    ...atomicEvent(sequence, phase),
    atom: {
      key: "subagent.lifecycle",
      kind: "agent",
      label: "Subagent Lifecycle",
      level: "runtime",
    },
    instance: {
      id: "subagent-lifecycle-1",
    },
    payload:
      phase === "start"
        ? {
            values: {
              agentId: "child-1",
              agentName: "Reviewer",
              agentSessionId: "session-1.agent.child-1",
              agentType: "code",
              parentSessionId: "session-1",
              profileId: "reviewer",
              taskId: "task-1",
            },
          }
        : {
            summary: "succeeded",
          },
  };
}

function createTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "yiku-flow-registry-"));
  directories.push(directory);
  return directory;
}
