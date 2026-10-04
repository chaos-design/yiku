import { describe, expect, it, vi } from "vitest";
import { createSkillDescriptor, createSkillSnapshot } from "../../src/skills/skill-types.js";
import { SkillWorker } from "../../src/skills/skill-worker.js";

describe("SkillWorker", () => {
  it("runs immutable snapshots and returns structured results", async () => {
    const run = vi.fn(async ({ prompt }: { readonly prompt: string }) => `done: ${prompt}`);
    const worker = new SkillWorker({
      idGenerator: () => "worker-1",
      run,
    });

    await expect(worker.run(snapshot("review"), "inspect changes")).resolves.toEqual({
      output: "done: inspect changes",
      skillName: "review",
      status: "succeeded",
      workerId: "worker-1",
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "inspect changes",
        snapshot: expect.objectContaining({ name: "review" }),
        workerId: "worker-1",
      }),
    );
  });

  it("limits concurrency and honors cancellation while waiting", async () => {
    let release: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi
      .fn()
      .mockImplementationOnce(async () => {
        await first;
        return "first";
      })
      .mockResolvedValue("second");
    const worker = new SkillWorker({ maxParallelWorkers: 1, run });
    const active = worker.run(snapshot("review"), "first");
    const controller = new AbortController();
    const waiting = worker.run(snapshot("review"), "second", controller.signal);
    controller.abort(new Error("cancelled"));

    await expect(waiting).rejects.toThrow("cancelled");
    expect(run).toHaveBeenCalledTimes(1);
    release?.();
    await expect(active).resolves.toMatchObject({ output: "first" });
  });

  it("validates concurrency, prompts, and pre-aborted signals", async () => {
    expect(() => new SkillWorker({ maxParallelWorkers: 0, run: async () => "unused" })).toThrow(
      "positive integer",
    );
    expect(() => new SkillWorker({ maxParallelWorkers: 1.5, run: async () => "unused" })).toThrow(
      "positive integer",
    );

    const worker = new SkillWorker({ run: async () => "unused" });
    await expect(worker.run(snapshot("review"), "   ")).rejects.toThrow("must be non-empty");
    const controller = new AbortController();
    controller.abort("stop");
    await expect(worker.run(snapshot("review"), "inspect", controller.signal)).rejects.toThrow(
      "Skill Worker was cancelled",
    );
  });

  it("emits success and failure events while forwarding active signals", async () => {
    const onEvent = vi.fn();
    const signal = new AbortController().signal;
    const worker = new SkillWorker({
      idGenerator: () => "worker-events",
      onEvent,
      run: vi.fn().mockResolvedValueOnce("done").mockRejectedValueOnce(new Error("failed")),
    });

    await expect(worker.run(snapshot("review"), " inspect ", signal)).resolves.toMatchObject({
      output: "done",
    });
    await expect(worker.run(snapshot("review"), "fail")).rejects.toThrow("failed");
    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "skill_worker_started",
      "skill_worker_finished",
      "skill_worker_started",
      "skill_worker_finished",
    ]);
    expect(onEvent.mock.calls.map(([event]) => event.status).filter(Boolean)).toEqual([
      "succeeded",
      "failed",
    ]);
  });

  it("starts an un-signalled queued worker after the active worker releases", async () => {
    let release: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = new SkillWorker({
      maxParallelWorkers: 1,
      run: vi
        .fn()
        .mockImplementationOnce(async () => {
          await first;
          return "first";
        })
        .mockResolvedValueOnce("second"),
    });

    const active = worker.run(snapshot("review"), "first");
    const waiting = worker.run(snapshot("review"), "second");
    release?.();
    await expect(active).resolves.toMatchObject({ output: "first" });
    await expect(waiting).resolves.toMatchObject({ output: "second" });
  });
});

function snapshot(name: string) {
  return createSkillSnapshot(
    createSkillDescriptor({
      agentTypes: ["code"],
      description: "Review code.",
      digest: "a".repeat(64),
      instructions: "Review.",
      mcpTargets: [],
      name,
      path: `/workspace/${name}/SKILL.md`,
      source: "project",
      version: "1.0.0",
    }),
    "2026-08-08T00:00:00.000Z",
  );
}
