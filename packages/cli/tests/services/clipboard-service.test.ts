import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ClipboardService, type ClipboardSpawn } from "../../src/services/clipboard-service.js";

describe("ClipboardService", () => {
  it.each([
    ["darwin", "pbcopy", []],
    ["win32", "clip", []],
    ["linux", "wl-copy", []],
  ] as const)("writes through the %s clipboard command", async (platform, command, args) => {
    const fixture = spawnFixture();
    const service = new ClipboardService({ platform, spawn: fixture.spawn });

    const write = service.write("answer");
    await fixture.waitForInput();
    fixture.close(0);

    await expect(write).resolves.toBeUndefined();
    expect(fixture.spawn).toHaveBeenCalledWith(
      command,
      args,
      expect.objectContaining({ stdio: "pipe" }),
    );
    expect(fixture.input()).toBe("answer");
  });

  it("falls back to xclip only when wl-copy is unavailable", async () => {
    const first = spawnFixture();
    const second = spawnFixture();
    const spawn = vi
      .fn<ClipboardSpawn>()
      .mockImplementationOnce(first.spawn)
      .mockImplementationOnce(second.spawn);
    const service = new ClipboardService({ platform: "linux", spawn });

    const write = service.write("answer");
    first.error(Object.assign(new Error("missing"), { code: "ENOENT" }));
    await second.waitForInput();
    second.close(0);

    await expect(write).resolves.toBeUndefined();
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      "xclip",
      ["-selection", "clipboard"],
      expect.objectContaining({ stdio: "pipe" }),
    );
    expect(second.input()).toBe("answer");
  });

  it("does not fall back for other wl-copy failures", async () => {
    const fixture = spawnFixture();
    const service = new ClipboardService({ platform: "linux", spawn: fixture.spawn });

    const write = service.write("answer");
    fixture.error(Object.assign(new Error("denied"), { code: "EACCES" }));

    await expect(write).rejects.toThrow("Unable to start clipboard command wl-copy: denied");
    expect(fixture.spawn).toHaveBeenCalledOnce();
  });

  it("rejects stdin errors and non-zero exits", async () => {
    const stdinFailure = spawnFixture();
    const stdinWrite = new ClipboardService({
      platform: "darwin",
      spawn: stdinFailure.spawn,
    }).write("answer");
    stdinFailure.stdinError(new Error("broken pipe"));
    await expect(stdinWrite).rejects.toThrow("Unable to write to clipboard command pbcopy");

    const exitFailure = spawnFixture();
    const exitWrite = new ClipboardService({
      platform: "win32",
      spawn: exitFailure.spawn,
    }).write("answer");
    exitFailure.stderr.write("clipboard unavailable");
    exitFailure.close(2);
    await expect(exitWrite).rejects.toThrow(
      "Clipboard command clip exited with code 2: clipboard unavailable",
    );
  });

  it("rejects unsupported platforms", async () => {
    const fixture = spawnFixture();
    const service = new ClipboardService({
      platform: "aix",
      spawn: fixture.spawn,
    });

    await expect(service.write("answer")).rejects.toThrow(
      "Clipboard is not supported on platform aix.",
    );
    expect(fixture.spawn).not.toHaveBeenCalled();
  });
});

function spawnFixture() {
  const child = new EventEmitter();
  const stdin = new PassThrough();
  const stderr = new PassThrough();
  const stdout = new PassThrough();
  const inputChunks: Buffer[] = [];
  stdin.on("data", (chunk: Buffer) => inputChunks.push(chunk));

  const spawn = vi.fn<ClipboardSpawn>(() =>
    Object.assign(child, {
      stderr,
      stdin,
      stdout,
    }),
  );

  return {
    child,
    close: (code: number | null) => child.emit("close", code),
    error: (error: Error) => child.emit("error", error),
    input: () => Buffer.concat(inputChunks).toString("utf8"),
    spawn,
    stderr,
    stdinError: (error: Error) => stdin.emit("error", error),
    waitForInput: () =>
      new Promise<void>((resolve) => {
        if (stdin.writableEnded) {
          resolve();
          return;
        }
        stdin.once("finish", resolve);
      }),
  };
}
