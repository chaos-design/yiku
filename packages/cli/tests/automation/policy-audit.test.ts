import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PolicyAuditLog, type PolicyAuditRecord } from "../../src/automation/policy-audit.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("PolicyAuditLog", () => {
  it("writes serialized private records without sensitive payloads", async () => {
    const root = await temporaryDirectory();
    const filePath = join(root, ".yiku", "audit", "cli-policy.ndjson");
    const audit = new PolicyAuditLog({
      filePath,
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });

    await Promise.all([
      audit.append(record("2026-08-19T00:00:00.000Z", "first")),
      audit.append(record("2026-08-19T00:00:01.000Z", "second")),
    ]);

    const lines = (await readFile(filePath, "utf8")).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line).reason)).toEqual(["first", "second"]);
    expect(await readFile(filePath, "utf8")).not.toContain("secret-value");
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(filePath))).mode & 0o777).toBe(0o700);
  });

  it("rotates bounded files and rejects a symbolic-link destination", async () => {
    const root = await temporaryDirectory();
    const filePath = join(root, "audit", "cli-policy.ndjson");
    const audit = new PolicyAuditLog({ filePath, maxBytes: 1 });
    await audit.append(record("2026-08-19T00:00:00.000Z", "first"));
    await audit.append(record("2026-08-19T00:00:01.000Z", "second"));

    expect(
      (await readdir(dirname(filePath))).filter((name) => name.includes("20260819")),
    ).toHaveLength(1);

    const target = join(root, "target.ndjson");
    const link = join(root, "linked.ndjson");
    await writeFile(target, "", { mode: 0o600 });
    await symlink(target, link);
    const unsafe = new PolicyAuditLog({ filePath: link });
    await expect(unsafe.append(record("2026-08-19T00:00:02.000Z", "unsafe"))).rejects.toThrow(
      "symbolic link",
    );
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });

  it("validates limits and rejects unsafe existing destinations", async () => {
    expect(() => new PolicyAuditLog({ maxBytes: 0 })).toThrow("positive integer");
    expect(() => new PolicyAuditLog({ retentionDays: 29 })).toThrow("between 30 and 365");

    const root = await temporaryDirectory();
    const publicFile = join(root, "public.ndjson");
    await writeFile(publicFile, "", { mode: 0o600 });
    await chmod(publicFile, 0o644);
    await expect(
      new PolicyAuditLog({ filePath: publicFile }).append(
        record("2026-08-20T00:00:00.000Z", "public"),
      ),
    ).rejects.toThrow("must not be accessible");

    const directoryPath = join(root, "directory.ndjson");
    await mkdir(directoryPath);
    await expect(
      new PolicyAuditLog({ filePath: directoryPath }).append(
        record("2026-08-20T00:00:01.000Z", "directory"),
      ),
    ).rejects.toThrow("regular file");
  });

  it("rotates by date and removes expired rotated files", async () => {
    const root = await temporaryDirectory();
    const filePath = join(root, "audit", "cli-policy.ndjson");
    const now = new Date("2026-08-20T00:00:00.000Z");
    const audit = new PolicyAuditLog({
      filePath,
      maxBytes: 1,
      now: () => now,
      retentionDays: 30,
    });
    await audit.append(record("2026-08-20T00:00:00.000Z", "first"));
    await audit.append(record("2026-08-20T00:00:01.000Z", "second"));
    const directory = dirname(filePath);
    const oldRotated = (await readdir(directory))
      .map((name) => join(directory, name))
      .find((path) => path !== filePath);
    expect(oldRotated).toBeDefined();
    await utimes(
      oldRotated ?? "",
      new Date("2026-06-01T00:00:00.000Z"),
      new Date("2026-06-01T00:00:00.000Z"),
    );
    await audit.append(record("2026-08-20T00:00:02.000Z", "third"));
    await expect(lstat(oldRotated ?? "")).rejects.toMatchObject({ code: "ENOENT" });

    const dailyPath = join(root, "daily", "cli-policy.ndjson");
    const daily = new PolicyAuditLog({ filePath: dailyPath, now: () => now });
    await daily.append(record("2026-08-20T00:00:03.000Z", "daily-first"));
    await utimes(
      dailyPath,
      new Date("2026-08-19T00:00:00.000Z"),
      new Date("2026-08-19T00:00:00.000Z"),
    );
    await daily.append(record("2026-08-20T00:00:04.000Z", "daily-second"));
    expect((await readdir(dirname(dailyPath))).length).toBe(2);
  });

  it("supports platforms without getuid and rejects linked audit directories", async () => {
    const root = await temporaryDirectory();
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    Object.defineProperty(process, "getuid", {
      configurable: true,
      value: undefined,
    });
    try {
      const filePath = join(root, "portable", "cli-policy.ndjson");
      await expect(
        new PolicyAuditLog({ filePath }).append(record("2026-08-20T00:00:00.000Z", "portable")),
      ).resolves.toBeUndefined();
    } finally {
      if (descriptor !== undefined) {
        Object.defineProperty(process, "getuid", descriptor);
      }
    }

    const target = join(root, "target-directory");
    const linkedDirectory = join(root, "linked-directory");
    await mkdir(target);
    await symlink(target, linkedDirectory);
    await expect(
      new PolicyAuditLog({ filePath: join(linkedDirectory, "cli-policy.ndjson") }).append(
        record("2026-08-20T00:00:01.000Z", "linked"),
      ),
    ).rejects.toThrow("not owned by the current user");
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "yiku-policy-audit-"));
  directories.push(directory);
  await mkdir(directory, { recursive: true });
  return directory;
}

function record(timestamp: string, reason: string): PolicyAuditRecord {
  return {
    decision: "allow",
    event: "permission.allow",
    reason,
    resourceDigest: "digest-only",
    sessionId: "session-1",
    timestamp,
    workspaceId: "/workspace",
  };
}
