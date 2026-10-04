import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ShellCommandService, type ShellSpawn } from "../../src/services/shell-command-service.js";

describe("ShellCommandService", () => {
  it("captures stdout, stderr, and the exit code through the configured shell", async () => {
    const fixture = spawnFixture();
    const service = new ShellCommandService({
      shell: ["/bin/sh", "-c"],
      spawn: fixture.spawn,
    });

    const run = service.run("echo hi");
    fixture.stdout.write("hi\n");
    fixture.stderr.write("warn\n");
    fixture.close(0);

    await expect(run).resolves.toEqual({
      exitCode: 0,
      stderr: "warn\n",
      stdout: "hi\n",
      timedOut: false,
      truncated: false,
    });
    expect(fixture.spawn).toHaveBeenCalledWith(
      "/bin/sh",
      ["-c", "echo hi"],
      expect.objectContaining({ stdio: "pipe" }),
    );
  });

  it("rejects an empty command without spawning a process", async () => {
    const fixture = spawnFixture();
    const service = new ShellCommandService({ spawn: fixture.spawn });

    await expect(service.run("   ")).rejects.toThrow("Shell command must not be empty.");
    expect(fixture.spawn).not.toHaveBeenCalled();
  });

  it("kills the child and reports a timeout when the command exceeds the limit", async () => {
    vi.useFakeTimers();
    try {
      const fixture = spawnFixture();
      const service = new ShellCommandService({
        shell: ["/bin/sh", "-c"],
        spawn: fixture.spawn,
        timeoutMs: 50,
      });

      const run = service.run("sleep 5");
      vi.advanceTimersByTime(50);
      expect(fixture.kill).toHaveBeenCalledWith("SIGKILL");
      fixture.close(null);

      await expect(run).resolves.toMatchObject({ exitCode: null, timedOut: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("kills the child when the abort signal fires", async () => {
    const fixture = spawnFixture();
    const service = new ShellCommandService({ spawn: fixture.spawn });
    const controller = new AbortController();

    const run = service.run("sleep 5", { signal: controller.signal });
    controller.abort();
    expect(fixture.kill).toHaveBeenCalledWith("SIGKILL");
    fixture.close(null);

    await expect(run).resolves.toMatchObject({ exitCode: null });
  });

  it("marks output as truncated once the byte cap is exceeded", async () => {
    const fixture = spawnFixture();
    const service = new ShellCommandService({ spawn: fixture.spawn });

    const run = service.run("yes");
    fixture.stdout.write("x".repeat(64_001));
    fixture.close(0);

    const result = await run;
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBe(64_000);
  });

  it("wraps spawn ENOENT failures with the command name", async () => {
    const spawn = vi.fn<ShellSpawn>(() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    const service = new ShellCommandService({ shell: ["/bin/missing", "-c"], spawn });

    await expect(service.run("echo hi")).rejects.toThrow(
      "Unable to start shell command /bin/missing: missing",
    );
  });

  it("runs a real command end to end on the host shell", async () => {
    const service = new ShellCommandService();

    const result = await service.run("printf 'hello world'");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello world");
    expect(result.timedOut).toBe(false);
  });
});

function spawnFixture() {
  const child = new EventEmitter();
  const stdin = new PassThrough();
  const stderr = new PassThrough();
  const stdout = new PassThrough();
  const kill = vi.fn();

  const spawn = vi.fn<ShellSpawn>(() =>
    Object.assign(child, {
      kill,
      stderr,
      stdin,
      stdout,
    }),
  );

  return {
    child,
    close: (code: number | null) => child.emit("close", code),
    error: (error: Error) => child.emit("error", error),
    kill,
    spawn,
    stderr,
    stdout,
  };
}
