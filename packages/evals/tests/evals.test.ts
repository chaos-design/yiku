import { AtomicFlowRun } from "@yiku/atomic-flow";
import { describe, expect, it } from "vitest";
import {
  EvalRunner,
  EvaluationError,
  FinalOutputEvaluator,
  FlowIntegrityEvaluator,
  MemorySafetyEvaluator,
} from "../src/index.js";
import type { Evaluator } from "../src/types.js";

describe("default evaluators", () => {
  it("accepts complete flows, final output, and safe memory summaries", () => {
    const flow = completeFlow();
    const input = {
      finalOutput: "done",
      flow: flow.snapshot(),
    };

    expect(new FlowIntegrityEvaluator().evaluate(input)).toMatchObject({ passed: true });
    expect(new FinalOutputEvaluator().evaluate(input)).toMatchObject({ passed: true });
    expect(new MemorySafetyEvaluator().evaluate(input)).toMatchObject({ passed: true });
  });

  it("detects open instances, orphan parents, empty output, and memory secrets", () => {
    const flow = new AtomicFlowRun({ runId: "run" });
    flow.start({
      atom: {
        key: "memory.write",
        kind: "memory",
        label: "Memory Write",
        level: "runtime",
      },
      parentInstanceId: "missing",
      payload: {
        summary: "Bearer abcdefghijklmnop",
      },
    });
    const input = {
      finalOutput: " ",
      flow: flow.snapshot(),
    };

    expect(new FlowIntegrityEvaluator().evaluate(input)).toMatchObject({
      passed: false,
      summary: expect.stringContaining("orphan parent"),
    });
    expect(new FinalOutputEvaluator().evaluate(input)).toMatchObject({ passed: false });
    expect(new MemorySafetyEvaluator().evaluate(input)).toMatchObject({ passed: false });
  });
});

describe("EvalRunner", () => {
  it("runs defaults and emits trigger, evaluator, scorecard, and gate atoms", async () => {
    const flow = completeFlow();
    const rootId = flow.snapshot().events[0]?.instance.id;
    const scorecard = await new EvalRunner().run({
      atomicFlow: flow,
      finalOutput: "done",
      flow: flow.snapshot(),
      ...(rootId !== undefined ? { parentInstanceId: rootId } : {}),
    });

    expect(scorecard).toMatchObject({
      averageScore: 1,
      passed: true,
      results: expect.arrayContaining([
        expect.objectContaining({ key: "flow-integrity" }),
        expect.objectContaining({ key: "final-output" }),
        expect.objectContaining({ key: "memory-safety" }),
      ]),
    });
    expect(flow.snapshot().events.map((event) => event.atom.key)).toEqual(
      expect.arrayContaining(["eval.trigger", "eval.scorecard", "eval.gate"]),
    );
  });

  it("supports judges and rejects scorecards below the configured threshold", async () => {
    const runner = new EvalRunner({
      evaluators: [],
      judge: {
        async evaluate() {
          return {
            key: "judge",
            label: "Judge",
            passed: false,
            score: 0.5,
            summary: "Needs work.",
          };
        },
      },
      passThreshold: 0.8,
    });

    await expect(
      runner.run({
        finalOutput: "output",
        flow: completeFlow().snapshot(),
      }),
    ).resolves.toMatchObject({
      averageScore: 0.5,
      passed: false,
    });
  });

  it("turns evaluator failures and invalid results into failed results", async () => {
    const throwing: Evaluator = {
      key: "throwing",
      label: "Throwing",
      evaluate() {
        throw new Error("offline");
      },
    };
    const invalid: Evaluator = {
      key: "invalid",
      label: "Invalid",
      evaluate() {
        return {
          key: "",
          label: "Invalid",
          passed: true,
          score: 2,
          summary: "invalid",
        };
      },
    };
    const scorecard = await new EvalRunner({
      evaluators: [throwing, invalid],
    }).run({
      finalOutput: "output",
      flow: completeFlow().snapshot(),
    });

    expect(scorecard.passed).toBe(false);
    expect(scorecard.results).toEqual([
      expect.objectContaining({ error: "offline", passed: false }),
      expect.objectContaining({ error: expect.stringContaining("invalid result"), passed: false }),
    ]);
  });

  it("supports empty evaluator sets, aborts, and threshold validation", async () => {
    await expect(
      new EvalRunner({ evaluators: [] }).run({
        finalOutput: "output",
        flow: completeFlow().snapshot(),
      }),
    ).resolves.toMatchObject({ averageScore: 1, passed: true });

    const controller = new AbortController();
    controller.abort();
    await expect(
      new EvalRunner().run({
        finalOutput: "output",
        flow: completeFlow().snapshot(),
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(EvaluationError);
    expect(() => new EvalRunner({ passThreshold: 2 })).toThrow("between 0 and 1");
    expect(() => new EvalRunner({ passThreshold: -1 })).toThrow("between 0 and 1");
    expect(() => new EvalRunner({ passThreshold: Number.NaN })).toThrow("between 0 and 1");
  });

  it("normalizes non-Error failures and propagates evaluator cancellation", async () => {
    const stringFailure = await new EvalRunner({
      evaluators: [
        {
          evaluate() {
            throw "offline";
          },
          key: "string-failure",
          label: "String Failure",
        },
      ],
    }).run({
      finalOutput: "output",
      flow: completeFlow().snapshot(),
    });
    expect(stringFailure.results[0]).toMatchObject({
      error: "offline",
      passed: false,
    });

    const flow = completeFlow();
    await expect(
      new EvalRunner({
        evaluators: [
          {
            evaluate() {
              throw new EvaluationError("EVAL_ABORTED", "Cancelled.");
            },
            key: "cancelled",
            label: "Cancelled",
          },
        ],
      }).run({
        atomicFlow: flow,
        finalOutput: "output",
        flow: flow.snapshot(),
      }),
    ).rejects.toMatchObject({ code: "EVAL_ABORTED" });
    expect(flow.snapshot().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          atom: expect.objectContaining({ key: "eval.cancelled" }),
          phase: "error",
        }),
      ]),
    );
  });

  it("checks cancellation again after evaluators finish", async () => {
    const controller = new AbortController();
    await expect(
      new EvalRunner({
        evaluators: [
          {
            evaluate() {
              controller.abort(new Error("cancel"));
              return {
                key: "cancel-after",
                label: "Cancel After",
                passed: true,
                score: 1,
                summary: "Finished.",
              };
            },
            key: "cancel-after",
            label: "Cancel After",
          },
        ],
      }).run({
        finalOutput: "output",
        flow: completeFlow().snapshot(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "EVAL_ABORTED" });
  });
});

function completeFlow(): AtomicFlowRun {
  const flow = new AtomicFlowRun({
    clock: () => new Date("2026-07-31T00:00:00.000Z"),
    runId: "run",
  });
  const root = flow.start({
    atom: {
      key: "run",
      kind: "input",
      label: "Run",
      level: "runtime",
    },
    instanceId: "run-instance",
  });
  root.end();
  return flow;
}
