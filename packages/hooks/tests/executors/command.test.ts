import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HookExecutionError, HookProtocolError, HookTimeoutError } from "../../src/errors.js";
import { CommandHookExecutor } from "../../src/executors/command.js";
import { HookLimits } from "../../src/security/limits.js";
import type { CommandHookHandler, HookInvocation } from "../../src/types.js";

const fixturePath = fileURLToPath(new URL("./fixtures/command-fixture.mjs", import.meta.url));

describe("CommandHookExecutor", () => {
  it("writes event JSON to stdin and exposes bounded environment", async () => {
    const executor = new CommandHookExecutor();
    const invocation = commandInvocation("SessionStart", commandHandler("context"));

    const result = await executor.execute(invocation, invocation.handler, executionContext());
    const context = JSON.parse(result.output?.additionalContext as string);

    expect(result.status).toBe("success");
    expect(context).toEqual({
      cwd: process.cwd(),
      eventName: "SessionStart",
      projectDir: process.cwd(),
      sessionId: "session-1",
    });
  });

  it("maps blocking and non-blocking exit codes", async () => {
    const executor = new CommandHookExecutor();
    const blocked = commandInvocation("Stop", commandHandler("block"));
    const failed = commandInvocation("Stop", commandHandler("error"));

    await expect(
      executor.execute(blocked, blocked.handler, executionContext()),
    ).resolves.toMatchObject({
      exitCode: 2,
      output: {
        action: "block",
        reason: "blocked by fixture",
      },
      status: "success",
    });
    await expect(
      executor.execute(failed, failed.handler, executionContext()),
    ).resolves.toMatchObject({
      errorCode: "HOOK_EXECUTION_FAILED",
      exitCode: 7,
      status: "error",
      stderr: "fixture failed",
    });
  });

  it("rejects malformed JSON and records output truncation", async () => {
    const invalid = commandInvocation("SessionStart", commandHandler("invalid-json"));
    await expect(
      new CommandHookExecutor().execute(invalid, invalid.handler, executionContext()),
    ).rejects.toBeInstanceOf(HookProtocolError);

    const large = commandInvocation("SessionStart", commandHandler("large"));
    const result = await new CommandHookExecutor({
      limits: new HookLimits({ maxOutputBytes: 128 }),
    }).execute(large, large.handler, executionContext());

    expect(result.stdout).toHaveLength(128);
    expect(result.truncatedStdoutBytes).toBe(4_096 - 128);
  });

  it("terminates the process group on timeout and abort", async () => {
    const invocation = commandInvocation("SessionStart", commandHandler("hang"));
    const executor = new CommandHookExecutor();

    await expect(
      executor.execute(invocation, invocation.handler, {
        ...executionContext(),
        deadline: Date.now() + 100,
      }),
    ).rejects.toBeInstanceOf(HookTimeoutError);

    const controller = new AbortController();
    const execution = executor.execute(invocation, invocation.handler, {
      ...executionContext(),
      deadline: Date.now() + 5_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort("canceled"), 50);
    await expect(execution).rejects.toMatchObject({ code: "HOOK_ABORTED" });
  });

  it("rejects oversized input and the wrong handler type", async () => {
    const invocation = commandInvocation("SessionStart", commandHandler("context"));
    const limited = new CommandHookExecutor({
      limits: new HookLimits({ maxInputBytes: 10 }),
    });

    await expect(
      limited.execute(invocation, invocation.handler, executionContext()),
    ).rejects.toBeInstanceOf(HookExecutionError);
    await expect(
      new CommandHookExecutor().execute(
        invocation,
        {
          model: "fast",
          prompt: "wrong",
          type: "prompt",
        },
        executionContext(),
      ),
    ).rejects.toThrow("non-command");
  });

  it("rejects expired deadlines, pre-aborted signals, and process startup failures", async () => {
    const invocation = commandInvocation("SessionStart", commandHandler("context"));
    await expect(
      new CommandHookExecutor().execute(invocation, invocation.handler, {
        ...executionContext(),
        deadline: Date.now() - 1,
      }),
    ).rejects.toBeInstanceOf(HookTimeoutError);

    const controller = new AbortController();
    controller.abort("already canceled");
    const hanging = commandInvocation("SessionStart", commandHandler("hang"));
    await expect(
      new CommandHookExecutor().execute(hanging, hanging.handler, {
        ...executionContext(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "HOOK_ABORTED" });

    const missing = commandInvocation("SessionStart", {
      args: [],
      command: "/definitely/missing/yiku-hook",
      type: "command",
    });
    await expect(
      new CommandHookExecutor().execute(missing, missing.handler, executionContext()),
    ).rejects.toThrow("Unable to start");
  });

  it("supports shell commands, Windows resolution, and stderr truncation", async () => {
    const shell = commandInvocation("SessionStart", {
      command: "printf shell-output",
      type: "command",
    });
    await expect(
      new CommandHookExecutor().execute(shell, shell.handler, executionContext()),
    ).resolves.toMatchObject({
      output: { additionalContext: "shell-output" },
    });

    const windows = commandInvocation("SessionStart", {
      command: "Write-Output ok",
      type: "command",
    });
    await expect(
      new CommandHookExecutor({ platform: "win32" }).execute(
        windows,
        windows.handler,
        executionContext(),
      ),
    ).rejects.toBeInstanceOf(HookExecutionError);

    const largeStderr = commandInvocation("SessionStart", commandHandler("large-stderr"));
    await expect(
      new CommandHookExecutor({
        limits: new HookLimits({ maxOutputBytes: 128 }),
      }).execute(largeStderr, largeStderr.handler, executionContext()),
    ).resolves.toMatchObject({
      truncatedStderrBytes: 4_096 - 128,
    });
  });
});

function commandHandler(mode: string): CommandHookHandler {
  return {
    args: [fixturePath, mode],
    command: process.execPath,
    type: "command",
  };
}

function commandInvocation(
  eventName: "SessionStart" | "Stop",
  handler: CommandHookHandler,
): HookInvocation {
  const common = {
    cwd: process.cwd(),
    permission_mode: "default" as const,
    session_id: "session-1",
    transcript_path: "/tmp/transcript.jsonl",
  };
  const event =
    eventName === "SessionStart"
      ? {
          ...common,
          hook_event_name: eventName,
          source: "startup" as const,
        }
      : {
          ...common,
          hook_event_name: eventName,
          stop_hook_active: false,
        };

  return {
    event,
    handler,
    hookId: "hook-command",
    invocationId: "invocation-command",
    source: {
      priority: 500,
      type: "project",
    },
  };
}

function executionContext() {
  return {
    deadline: Date.now() + 5_000,
    depth: 0,
    environment: {
      TEST_HOOK_VALUE: "available",
    },
  };
}
