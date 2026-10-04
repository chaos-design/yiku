import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hookSource } from "../../src/config/source.js";
import { HookTrustError } from "../../src/errors.js";
import { type HookTrustDescriptor, sha256 } from "../../src/trust/canonical.js";
import { HookTrustStore } from "../../src/trust/store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("HookTrustStore", () => {
  it("persists, reloads, and revokes trusted descriptors", async () => {
    const directory = await temporaryDirectory();
    const filePath = join(directory, "trust", "hooks.json");
    const descriptor = trustDescriptor();
    const store = new HookTrustStore({
      filePath,
      now: () => new Date("2026-08-01T00:00:00.000Z"),
    });

    const entry = await store.approve(descriptor);

    expect(entry.approvedAt).toBe("2026-08-01T00:00:00.000Z");
    expect(await store.has(descriptor)).toBe(true);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      entries: [{ key: entry.key }],
      version: 1,
    });

    const reopened = new HookTrustStore({ filePath });
    expect(await reopened.has(descriptor)).toBe(true);
    expect(await reopened.revoke(entry.key)).toBe(true);
    expect(await reopened.revoke(entry.key)).toBe(false);
    expect(await reopened.has(descriptor)).toBe(false);
  });

  it("serializes concurrent approvals without dropping entries", async () => {
    const directory = await temporaryDirectory();
    const store = new HookTrustStore({ filePath: join(directory, "hooks.json") });

    await Promise.all([
      store.approve(trustDescriptor("hook-1")),
      store.approve(trustDescriptor("hook-2")),
      store.approve(trustDescriptor("hook-3")),
    ]);

    expect(await store.list()).toHaveLength(3);
  });

  it("rejects corrupt and tampered trust files", async () => {
    const directory = await temporaryDirectory();
    const corruptPath = join(directory, "corrupt.json");
    const tamperedPath = join(directory, "tampered.json");
    await writeFile(corruptPath, "{", "utf8");
    await writeFile(
      tamperedPath,
      JSON.stringify({
        entries: [
          {
            approvedAt: "2026-08-01T00:00:00.000Z",
            descriptor: trustDescriptor(),
            key: "trust_tampered",
          },
        ],
        version: 1,
      }),
      "utf8",
    );

    await expect(new HookTrustStore({ filePath: corruptPath }).list()).rejects.toThrow(
      HookTrustError,
    );
    await expect(new HookTrustStore({ filePath: tamperedPath }).list()).rejects.toThrow(
      "hash does not match",
    );
  });

  it("rejects relative paths and surfaces atomic persistence failures", async () => {
    expect(() => new HookTrustStore({ filePath: "relative.json" })).toThrow("must be absolute");

    const directory = await temporaryDirectory();
    const filePath = join(directory, "hooks.json");
    const store = new HookTrustStore({ filePath });
    await store.list();
    await mkdir(filePath);

    await expect(store.approve(trustDescriptor())).rejects.toThrow(
      "Unable to persist Hook trust store",
    );
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "yiku-hooks-trust-"));
  temporaryDirectories.push(directory);
  return directory;
}

function trustDescriptor(hookId = "hook-1"): HookTrustDescriptor {
  return {
    capability: `node ${hookId}.mjs`,
    executorType: "command",
    handlerHash: sha256(hookId),
    hookId,
    opaque: true,
    source: hookSource("project", { path: "/workspace/.yiku/settings.json" }),
  };
}
