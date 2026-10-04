import {
  CallbackHookExecutor,
  HookConfigCompiler,
  HookEngine,
  HookExecutorRegistry,
  HookSession,
  hookSource,
} from "@yiku/hooks";
import { describe, expect, it } from "vitest";
import { TeamRuntime } from "../../src/tasks/team-runtime.js";

describe("TeamRuntime", () => {
  it("tracks assignment and allows idle transition", async () => {
    const team = teamRuntime(() => ({}));
    team.register("worker-1");
    team.assign("worker-1", "task-1");

    await expect(team.markIdle("worker-1")).resolves.toBe(true);
    expect(team.get("worker-1")).toEqual({
      idle: true,
      name: "worker-1",
    });
  });

  it("keeps a worker active when TeammateIdle is blocked", async () => {
    const team = teamRuntime(() => ({ action: "block", reason: "more work" }));
    team.register("worker-1");
    team.assign("worker-1", "task-1");

    await expect(team.markIdle("worker-1")).resolves.toBe(false);
    expect(team.get("worker-1")).toMatchObject({
      activeTaskId: "task-1",
      idle: false,
    });
  });

  it("validates workers and tasks", () => {
    const team = teamRuntime(() => ({}));

    expect(() => team.register("")).toThrow("non-empty");
    expect(() => team.assign("missing", "task")).toThrow("not found");
    team.register("worker-1");
    expect(() => team.register("worker-1")).toThrow("already exists");
    expect(team.list()).toHaveLength(1);
  });
});

function teamRuntime(callback: () => object): TeamRuntime {
  const snapshot = new HookConfigCompiler().compile([
    {
      source: hookSource("runtime"),
      value: {
        hooks: {
          TeammateIdle: [{ hooks: [{ callback, name: "idle", type: "callback" }] }],
        },
      },
    },
  ]).snapshot;
  const hookSession = new HookSession({
    engine: new HookEngine({
      executors: new HookExecutorRegistry([new CallbackHookExecutor()]),
      snapshot,
    }),
  });
  return new TeamRuntime({
    eventBase: {
      cwd: "/workspace",
      hook_event_name: "TeammateIdle",
      permission_mode: "default",
      session_id: "session-1",
      transcript_path: "/tmp/transcript.jsonl",
    },
    hookSession,
    teamName: "team",
  });
}
