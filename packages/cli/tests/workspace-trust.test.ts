import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceTrustStore } from "../src/workspace-trust.js";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;

describe("WorkspaceTrustStore", () => {
  it("persists workspace trust and expires it after seven days", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-workspace-trust-"));
    const workspaceDir = join(directory, "workspace");
    const filePath = join(directory, "home", ".yiku", "permission", "global.json");
    const now = new Date("2026-08-03T00:00:00.000Z");
    const store = new WorkspaceTrustStore(filePath);

    try {
      await mkdir(workspaceDir, { recursive: true });
      const canonicalWorkspaceDir = await realpath(workspaceDir);
      await expect(store.get(workspaceDir, now)).resolves.toBeUndefined();

      await expect(store.trust(workspaceDir, "read-write", now)).resolves.toMatchObject({
        accessMode: "read-write",
        expiresAt: new Date(now.getTime() + SEVEN_DAYS_MS).toISOString(),
        trustedAt: now.toISOString(),
      });

      await expect(store.get(workspaceDir, now)).resolves.toMatchObject({
        accessMode: "read-write",
        workspaceDir: canonicalWorkspaceDir,
      });
      await expect(
        store.get(workspaceDir, new Date(now.getTime() + SEVEN_DAYS_MS + 1)),
      ).resolves.toBeUndefined();
      await expect(readFile(filePath, "utf8")).resolves.toContain('"readWrite"');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("fails closed for corrupt trust files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-workspace-trust-corrupt-"));
    const filePath = join(directory, "workspaces.json");
    const store = new WorkspaceTrustStore(filePath);

    try {
      await mkdir(join(directory, "workspace"), { recursive: true });
      await writeFile(filePath, "{", "utf8");
      await expect(store.get(join(directory, "workspace"))).rejects.toThrow(
        "Unable to parse permission profile",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
