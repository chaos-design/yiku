import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCompletionDecision,
  createEvalAttemptRecord,
  createEvalBaseline,
  createEvalEvidenceIndex,
  FileEvalResultStore,
  type FileLockManager,
  sha256Digest,
  sha256Text,
} from "../../src/index.js";
import { storedFixture } from "./fixtures.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("FileEvalResultStore", () => {
  it("atomically writes immutable plans, attempts, and decisions with private modes", async () => {
    const rootDir = await temporaryDirectory();
    const fixture = await storedFixture();
    const store = new FileEvalResultStore({ rootDir });

    await store.writePlan(fixture.plan);
    await store.writeAttempt(fixture.commit);
    await store.writeDecision(fixture.decision);
    const stored = await store.readAttempt("run", "attempt");

    expect(stored).toEqual({
      ...fixture.commit,
      decision: fixture.decision,
    });
    expect((await stat(rootDir)).mode & 0o777).toBe(0o700);
    const all = await allPaths(rootDir);
    for (const path of all.files) {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    for (const path of all.directories) {
      expect((await stat(path)).mode & 0o777).toBe(0o700);
    }
    expect(all.directories.some((path) => path.endsWith(".tmp"))).toBe(false);
  });

  it("is idempotent for matching digests and rejects conflicting immutable records", async () => {
    const rootDir = await temporaryDirectory();
    const fixture = await storedFixture();
    const store = new FileEvalResultStore({ rootDir });
    await store.writePlan(fixture.plan);
    await store.writePlan(fixture.plan);
    await store.writeAttempt(fixture.commit);
    await store.writeAttempt(fixture.commit);
    await store.writeDecision(fixture.decision);
    await store.writeDecision(fixture.decision);

    const changedPlanSemantic = {
      attemptBudget: fixture.plan.attemptBudget,
      checks: fixture.plan.checks,
      createdAt: fixture.plan.createdAt,
      dimensionWeights: fixture.plan.dimensionWeights,
      limits: fixture.plan.limits,
      mode: fixture.plan.mode,
      profileId: fixture.plan.profileId,
      qualityThreshold: 0.9,
      runId: fixture.plan.runId,
      taskId: fixture.plan.taskId,
      version: fixture.plan.version,
    };
    await expect(
      store.writePlan({
        ...changedPlanSemantic,
        digest: sha256Digest(changedPlanSemantic),
      }),
    ).rejects.toMatchObject({ code: "EVAL_STORE_CONFLICT" });
    await expect(
      store.writeDecision(
        createCompletionDecision({
          action: "rejected",
          attemptId: "attempt",
          reasons: ["Different decision."],
          runId: "run",
          taskId: "task",
        }),
      ),
    ).rejects.toMatchObject({ code: "EVAL_STORE_CONFLICT" });
  });

  it("keeps a failed attempt commit invisible and removes its temporary directory", async () => {
    const rootDir = await temporaryDirectory();
    const fixture = await storedFixture();
    const store = new FileEvalResultStore({
      beforeCommit(operation) {
        if (operation === "attempt") {
          const error = new Error("No space left") as NodeJS.ErrnoException;
          error.code = "ENOSPC";
          throw error;
        }
      },
      rootDir,
    });
    await store.writePlan(fixture.plan);
    await expect(store.writeAttempt(fixture.commit)).rejects.toMatchObject({
      code: "EVAL_STORE_UNAVAILABLE",
    });
    await expect(store.readAttempt("run", "attempt")).resolves.toBeUndefined();

    const attemptsDir = join(rootDir, "runs", sha256Text("run"), "attempts");
    expect((await readdir(attemptsDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("detects corrupt records and unsupported schema versions without overwriting them", async () => {
    const rootDir = await temporaryDirectory();
    const fixture = await storedFixture();
    const store = new FileEvalResultStore({ rootDir });
    await store.writePlan(fixture.plan);
    await store.writeAttempt(fixture.commit);
    const scorecardPath = join(
      rootDir,
      "runs",
      sha256Text("run"),
      "attempts",
      sha256Text("attempt"),
      "scorecard.json",
    );
    await writeFile(scorecardPath, "{invalid", "utf8");
    await expect(store.readAttempt("run", "attempt")).rejects.toMatchObject({
      code: "EVAL_STORE_CORRUPT",
    });
    expect(await readFile(scorecardPath, "utf8")).toBe("{invalid");

    await writeFile(scorecardPath, JSON.stringify({ version: 2 }), "utf8");
    await expect(store.readAttempt("run", "attempt")).rejects.toMatchObject({
      code: "EVAL_SCHEMA_UNSUPPORTED",
    });
  });

  it("lists filtered run summaries using stable ordering", async () => {
    const rootDir = await temporaryDirectory();
    const fixture = await storedFixture();
    const store = new FileEvalResultStore({ rootDir });
    await store.writePlan(fixture.plan);
    await store.writeAttempt(fixture.commit);
    await store.writeDecision(fixture.decision);

    await expect(store.listRuns({ limit: 10 })).resolves.toEqual([
      expect.objectContaining({
        attemptCount: 1,
        decision: "accepted",
        profileId: "store-profile",
        runId: "run",
      }),
    ]);
    await expect(store.listRuns({ decision: "rejected", limit: 10 })).resolves.toEqual([]);
    await expect(store.listRuns({ limit: 0 })).rejects.toThrow("between 1 and 100");
  });

  it("persists approved baselines immutably", async () => {
    const rootDir = await temporaryDirectory();
    const fixture = await storedFixture();
    const store = new FileEvalResultStore({ rootDir });
    const baseline = createEvalBaseline({
      approvedAt: "2026-08-13T00:00:00.000Z",
      baselineVersion: "1.0.0",
      decision: fixture.decision,
      evaluatorVersions: {},
      profileId: fixture.plan.profileId,
      runtimeDigest: sha256Digest({ node: process.version }),
      scorecard: fixture.commit.scorecard,
      suiteId: "suite",
    });
    await store.writeBaseline(baseline);
    await store.writeBaseline(baseline);

    await expect(store.readBaseline("suite", "1.0.0")).resolves.toEqual(baseline);
    const conflicting = createEvalBaseline({
      approvedAt: "2026-08-13T00:00:01.000Z",
      baselineVersion: "1.0.0",
      decision: fixture.decision,
      evaluatorVersions: {},
      profileId: fixture.plan.profileId,
      runtimeDigest: sha256Digest({ node: process.version }),
      scorecard: fixture.commit.scorecard,
      suiteId: "suite",
    });
    await expect(store.writeBaseline(conflicting)).rejects.toMatchObject({
      code: "EVAL_STORE_CONFLICT",
    });
  });

  it("rejects a symbolic-link store root", async () => {
    const parent = await temporaryDirectory();
    const target = join(parent, "target");
    const link = join(parent, "link");
    await mkdir(target);
    await symlink(target, link);
    const store = new FileEvalResultStore({ rootDir: link });

    await expect(store.initialize()).rejects.toMatchObject({
      code: "EVAL_STORE_UNAVAILABLE",
    });
    await expect(access(target)).resolves.toBeUndefined();
  });

  it("repairs private permissions on existing store directories", async () => {
    const rootDir = await temporaryDirectory();
    await chmod(rootDir, 0o755);
    const store = new FileEvalResultStore({ rootDir });
    await store.initialize();

    expect((await lstat(rootDir)).mode & 0o777).toBe(0o700);
  });

  it("emits bounded store logs and metrics without changing persistence", async () => {
    const rootDir = await temporaryDirectory();
    const fixture = await storedFixture();
    const logs: unknown[] = [];
    const observations: unknown[] = [];
    const store = new FileEvalResultStore({
      logger: {
        log: (entry) => logs.push(entry),
      },
      metrics: {
        increment: () => undefined,
        observe: (name, value, labels) => observations.push({ labels, name, value }),
      },
      rootDir,
    });

    await store.writePlan(fixture.plan);

    expect(logs).toEqual([
      expect.objectContaining({
        event: "evaluation.store.operation",
        level: "debug",
        status: "success",
      }),
    ]);
    expect(observations).toEqual([
      expect.objectContaining({
        labels: { operation: "plan", status: "success" },
        name: "eval_store_operation_ms",
      }),
    ]);
  });

  it("rejects relative roots and retries initialization after a filesystem failure", async () => {
    expect(() => new FileEvalResultStore({ rootDir: "relative" })).toThrow("absolute");

    const parent = await temporaryDirectory();
    const rootDir = join(parent, "store");
    await writeFile(rootDir, "not a directory", "utf8");
    const store = new FileEvalResultStore({ rootDir });
    await expect(store.initialize()).rejects.toMatchObject({
      code: "EVAL_STORE_UNAVAILABLE",
    });
    await rm(rootDir);
    await expect(store.initialize()).resolves.toBeUndefined();
  });

  it("returns missing records and rejects attempts or decisions without their immutable parents", async () => {
    const rootDir = await temporaryDirectory();
    const fixture = await storedFixture();
    const store = new FileEvalResultStore({ rootDir });

    await expect(store.readBaseline("missing", "1.0.0")).resolves.toBeUndefined();
    await expect(store.readAttempt("missing", "attempt")).resolves.toBeUndefined();
    await expect(store.writeAttempt(fixture.commit)).rejects.toMatchObject({
      code: "EVAL_STORE_CONFLICT",
    });
    await expect(store.writeDecision(fixture.decision)).rejects.toMatchObject({
      code: "EVAL_STORE_CONFLICT",
    });
  });

  it("rejects conflicting attempts and inconsistent evidence identifiers", async () => {
    const rootDir = await temporaryDirectory();
    const fixture = await storedFixture();
    const store = new FileEvalResultStore({ rootDir });
    await store.writePlan(fixture.plan);
    await store.writeAttempt(fixture.commit);

    const conflictingAttempt = createEvalAttemptRecord({
      ...fixture.commit.attempt,
      contextDigest: sha256Text("different-context"),
    });
    await expect(
      store.writeAttempt({
        ...fixture.commit,
        attempt: conflictingAttempt,
      }),
    ).rejects.toMatchObject({ code: "EVAL_STORE_CONFLICT" });
    await expect(
      store.writeAttempt({
        ...fixture.commit,
        evidenceIndex: createEvalEvidenceIndex("other-attempt", []),
      }),
    ).rejects.toMatchObject({ code: "EVAL_INVALID_RESULT" });
  });

  it("lists empty and filtered runs while ignoring non-record directory entries", async () => {
    const rootDir = await temporaryDirectory();
    const fixture = await storedFixture();
    const store = new FileEvalResultStore({ rootDir });
    await store.writePlan(fixture.plan);
    const runsDir = join(rootDir, "runs");
    await writeFile(join(runsDir, "noise.txt"), "noise", "utf8");
    await mkdir(join(runsDir, "empty"));
    const attemptsDir = join(runsDir, sha256Text("run"), "attempts");
    await mkdir(attemptsDir, { recursive: true });
    await writeFile(join(attemptsDir, "noise.txt"), "noise", "utf8");
    await mkdir(join(attemptsDir, "empty"));

    await expect(store.listRuns({ limit: 100 })).resolves.toEqual([
      expect.objectContaining({
        attemptCount: 0,
        runId: "run",
        updatedAt: fixture.plan.createdAt,
      }),
    ]);
    await expect(store.listRuns({ limit: 100, profileId: "other" })).resolves.toEqual([]);
    await expect(store.listRuns({ cursor: "run", limit: 100 })).resolves.toEqual([]);
  });

  it("detects attempt directories copied under the wrong storage key", async () => {
    const rootDir = await temporaryDirectory();
    const fixture = await storedFixture();
    const store = new FileEvalResultStore({ rootDir });
    await store.writePlan(fixture.plan);
    await store.writeAttempt(fixture.commit);
    const attemptsDir = join(rootDir, "runs", sha256Text("run"), "attempts");
    await cp(
      join(attemptsDir, sha256Text("attempt")),
      join(attemptsDir, sha256Text("other-attempt")),
      { recursive: true },
    );

    await expect(store.readAttempt("run", "other-attempt")).rejects.toMatchObject({
      code: "EVAL_STORE_CORRUPT",
    });
  });

  it("records failed operations without allowing telemetry adapters to change errors", async () => {
    const rootDir = await temporaryDirectory();
    const fixture = await storedFixture();
    const increments: unknown[] = [];
    const logs: unknown[] = [];
    const store = new FileEvalResultStore({
      beforeCommit() {
        throw new Error("commit failed");
      },
      logger: {
        log: (entry) => logs.push(entry),
      },
      metrics: {
        increment: (name, labels) => increments.push({ labels, name }),
        observe: () => undefined,
      },
      rootDir,
    });
    await expect(store.writePlan(fixture.plan)).rejects.toMatchObject({
      code: "EVAL_STORE_UNAVAILABLE",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(increments).toEqual([
      expect.objectContaining({
        labels: {
          component: "store",
          errorCode: "EVAL_STORE_UNAVAILABLE",
        },
      }),
    ]);
    expect(logs).toEqual([
      expect.objectContaining({
        level: "error",
        status: "EVAL_STORE_UNAVAILABLE",
      }),
    ]);
  });

  it("serializes concurrent writes and maps raw lock failures into store telemetry", async () => {
    const rootDir = await temporaryDirectory();
    const fixture = await storedFixture();
    const store = new FileEvalResultStore({ rootDir });
    await Promise.all([store.writePlan(fixture.plan), store.writePlan(fixture.plan)]);

    const increments: unknown[] = [];
    const failing = new FileEvalResultStore({
      lockManager: {
        acquire: async () => {
          throw new Error("lock backend failed");
        },
        initialize: async () => undefined,
      } as unknown as FileLockManager,
      metrics: {
        increment: (name, labels) => increments.push({ labels, name }),
        observe: () => undefined,
      },
      rootDir: await temporaryDirectory(),
    });
    await expect(failing.writePlan(fixture.plan)).rejects.toThrow("lock backend failed");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(increments).toEqual([
      expect.objectContaining({
        labels: {
          component: "store",
          errorCode: "EVAL_STORE_UNAVAILABLE",
        },
      }),
    ]);
  });

  it("maps non-file baseline records to a stable store error", async () => {
    const rootDir = await temporaryDirectory();
    const store = new FileEvalResultStore({ rootDir });
    await store.initialize();
    await mkdir(join(rootDir, "baselines", sha256Text("suite"), `${sha256Text("1.0.0")}.json`), {
      recursive: true,
    });

    await expect(store.readBaseline("suite", "1.0.0")).rejects.toMatchObject({
      code: "EVAL_STORE_UNAVAILABLE",
    });
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = join(
    tmpdir(),
    `yiku-eval-store-${process.pid}-${Date.now()}-${temporaryDirectories.length}`,
  );
  await mkdir(directory, { mode: 0o700 });
  temporaryDirectories.push(directory);
  return directory;
}

async function allPaths(root: string): Promise<{
  readonly directories: readonly string[];
  readonly files: readonly string[];
}> {
  const directories: string[] = [root];
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(path);
        await visit(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  };
  await visit(root);
  return { directories, files };
}
