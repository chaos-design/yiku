import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HookSecurityError } from "../../src/errors.js";
import { inspectHookPath, requireSafeHookPath } from "../../src/security/path.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("hook path security", () => {
  it("inspects and accepts a private regular file", async () => {
    const directory = await temporaryDirectory();
    const filePath = join(directory, "hook.mjs");
    await writeFile(filePath, "export {};\n", { mode: 0o600 });
    const resolvedPath = await realpath(filePath);

    await expect(requireSafeHookPath(filePath)).resolves.toMatchObject({
      isSymbolicLink: false,
      mode: 0o600,
      path: filePath,
      realPath: resolvedPath,
    });
  });

  it("rejects relative, non-file, writable, and untrusted owner paths", async () => {
    const directory = await temporaryDirectory();
    const filePath = join(directory, "hook.mjs");
    await writeFile(filePath, "export {};\n", { mode: 0o600 });

    await expect(inspectHookPath("relative.mjs")).rejects.toBeInstanceOf(HookSecurityError);
    await expect(inspectHookPath(directory)).rejects.toThrow("regular file");

    await chmod(filePath, 0o602);
    await expect(requireSafeHookPath(filePath)).rejects.toThrow("world-writable");

    await chmod(filePath, 0o620);
    await expect(requireSafeHookPath(filePath)).rejects.toThrow("group-writable");

    await chmod(filePath, 0o600);
    await expect(
      requireSafeHookPath(filePath, { allowedOwnerIds: [Number.MAX_SAFE_INTEGER] }),
    ).rejects.toThrow("owner is not trusted");
  });

  it("rejects symlinks unless explicitly allowed", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "target.mjs");
    const link = join(directory, "hook.mjs");
    await writeFile(target, "export {};\n", { mode: 0o600 });
    await symlink(target, link);
    const resolvedTarget = await realpath(target);

    await expect(requireSafeHookPath(link)).rejects.toThrow("symbolic link");
    await expect(requireSafeHookPath(link, { allowSymbolicLink: true })).resolves.toMatchObject({
      isSymbolicLink: true,
      realPath: resolvedTarget,
    });
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "yiku-hook-path-"));
  temporaryDirectories.push(directory);
  return directory;
}
