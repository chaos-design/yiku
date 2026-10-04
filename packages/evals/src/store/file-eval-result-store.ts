import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { validateEvalBaseline } from "../baseline.js";
import { sha256Text } from "../canonical.js";
import { EvaluationError } from "../errors.js";
import {
  incrementEvalMetric,
  NoopEvalLogger,
  NoopEvalMetrics,
  observeEvalMetric,
  writeEvalLog,
} from "../observability.js";
import {
  validateCompletionDecision,
  validateEvalAttemptRecord,
  validateEvalEvidenceIndex,
} from "../records.js";
import { validateEvaluationScorecardDigest } from "../scoring.js";
import type {
  CompletionDecision,
  EvalAttemptCommit,
  EvalBaseline,
  EvalBaselineStore,
  EvalLogger,
  EvalMetrics,
  EvalResultStore,
  EvalRunQuery,
  EvalRunSummary,
  EvalStoredAttempt,
} from "../types.js";
import { validateEvalPlan, validateEvalPlanDigest } from "../validation.js";
import { FileLockManager } from "./lock.js";
import {
  parseStoredBaseline,
  parseStoredDecision,
  parseStoredEvalAttempt,
  parseStoredEvalPlan,
  parseStoredEvidenceIndex,
  parseStoredJson,
  parseStoredScorecard,
} from "./schema.js";

type StoreOperation = "attempt" | "baseline" | "decision" | "plan";

export interface FileEvalResultStoreOptions {
  readonly beforeCommit?:
    | ((operation: StoreOperation, destination: string) => Promise<void> | void)
    | undefined;
  readonly lockManager?: FileLockManager | undefined;
  readonly logger?: EvalLogger | undefined;
  readonly metrics?: EvalMetrics | undefined;
  readonly now?: (() => number) | undefined;
  readonly rootDir: string;
}

export class FileEvalResultStore implements EvalBaselineStore, EvalResultStore {
  private readonly beforeCommit:
    | ((operation: StoreOperation, destination: string) => Promise<void> | void)
    | undefined;
  private initializePromise: Promise<void> | undefined;
  private readonly lockManager: FileLockManager;
  private readonly logger: EvalLogger;
  private readonly metrics: EvalMetrics;
  private readonly now: () => number;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly rootDir: string;

  public constructor(options: FileEvalResultStoreOptions) {
    if (!isAbsolute(options.rootDir)) {
      throw unavailable("Evaluation store root directory must be absolute.");
    }
    this.rootDir = resolve(options.rootDir);
    this.beforeCommit = options.beforeCommit;
    this.logger = options.logger ?? new NoopEvalLogger();
    this.metrics = options.metrics ?? new NoopEvalMetrics();
    this.now = options.now ?? (() => performance.now());
    this.lockManager =
      options.lockManager ??
      new FileLockManager({
        lockDir: join(this.rootDir, "locks"),
      });
  }

  public initialize(): Promise<void> {
    this.initializePromise ??= this.initializeNow().catch((error: unknown) => {
      this.initializePromise = undefined;
      throw asStoreError("Could not initialize evaluation store.", error);
    });
    return this.initializePromise;
  }

  public async writePlan(plan: Parameters<EvalResultStore["writePlan"]>[0]): Promise<void> {
    validateEvalPlan(plan);
    validateEvalPlanDigest(plan);
    await this.enqueue(`plan:${plan.runId}`, async () => {
      await this.initialize();
      const lease = await this.lockManager.acquire(`plan:${plan.runId}`);
      try {
        const directory = this.runDir(plan.runId);
        await secureDirectory(directory);
        const destination = join(directory, "plan.json");
        const existing = await readOptional(destination);
        if (existing !== undefined) {
          const stored = parseStoredEvalPlan(parseStoredJson(existing, "Evaluation plan"));
          if (stored.digest === plan.digest) {
            return;
          }
          throw conflict(`Evaluation plan already exists with a different digest: ${plan.runId}.`);
        }
        await atomicWriteJson(destination, plan, "plan", this.beforeCommit);
      } finally {
        await lease.release();
      }
    });
  }

  public async writeBaseline(baseline: EvalBaseline): Promise<void> {
    validateEvalBaseline(baseline);
    await this.enqueue(`baseline:${baseline.suiteId}:${baseline.baselineVersion}`, async () => {
      await this.initialize();
      const lease = await this.lockManager.acquire(
        `baseline:${baseline.suiteId}:${baseline.baselineVersion}`,
      );
      try {
        const directory = join(this.rootDir, "baselines", storageKey(baseline.suiteId));
        await secureDirectory(directory);
        const destination = join(directory, `${storageKey(baseline.baselineVersion)}.json`);
        const existing = await readOptional(destination);
        if (existing !== undefined) {
          const stored = parseStoredBaseline(parseStoredJson(existing, "Evaluation baseline"));
          if (stored.digest === baseline.digest) {
            return;
          }
          throw conflict(
            `Evaluation baseline already exists with a different digest: ${baseline.suiteId}/${baseline.baselineVersion}.`,
          );
        }
        await atomicWriteJson(destination, baseline, "baseline", this.beforeCommit);
      } finally {
        await lease.release();
      }
    });
  }

  public async readBaseline(
    suiteId: string,
    baselineVersion: string,
  ): Promise<EvalBaseline | undefined> {
    await this.initialize();
    const filePath = join(
      this.rootDir,
      "baselines",
      storageKey(suiteId),
      `${storageKey(baselineVersion)}.json`,
    );
    try {
      const text = await readOptional(filePath);
      return text === undefined
        ? undefined
        : parseStoredBaseline(parseStoredJson(text, "Evaluation baseline"));
    } catch (error) {
      throw asStoreError("Could not read evaluation baseline.", error);
    }
  }

  public async writeAttempt(commit: EvalAttemptCommit): Promise<void> {
    validateAttemptCommit(commit);
    const { runId } = commit.scorecard;
    await this.enqueue(`attempt:${runId}:${commit.attempt.attemptId}`, async () => {
      await this.initialize();
      const lease = await this.lockManager.acquire(`attempt:${runId}:${commit.attempt.attemptId}`);
      let temporaryDirectory: string | undefined;
      try {
        const plan = await this.readPlan(runId);
        if (plan === undefined || plan.digest !== commit.attempt.planDigest) {
          throw conflict("Evaluation attempt does not reference the stored plan.");
        }
        if (
          plan.taskId !== commit.scorecard.taskId ||
          commit.scorecard.planDigest !== plan.digest
        ) {
          throw conflict("Evaluation attempt does not belong to the stored plan.");
        }

        const attemptsDirectory = join(this.runDir(runId), "attempts");
        await secureDirectory(attemptsDirectory);
        const destination = this.attemptDir(runId, commit.attempt.attemptId);
        if (await pathExists(destination)) {
          const stored = await this.readAttempt(runId, commit.attempt.attemptId);
          if (
            stored?.attempt.digest === commit.attempt.digest &&
            stored.evidenceIndex.digest === commit.evidenceIndex.digest &&
            stored.scorecard.digest === commit.scorecard.digest
          ) {
            return;
          }
          throw conflict(
            `Evaluation attempt already exists with different contents: ${commit.attempt.attemptId}.`,
          );
        }

        temporaryDirectory = join(
          attemptsDirectory,
          `.${basename(destination)}.${randomUUID()}.tmp`,
        );
        await mkdir(temporaryDirectory, { mode: 0o700 });
        await writeNewJson(join(temporaryDirectory, "attempt.json"), commit.attempt);
        await writeNewJson(join(temporaryDirectory, "scorecard.json"), commit.scorecard);
        await writeNewJson(join(temporaryDirectory, "evidence-index.json"), commit.evidenceIndex);
        await syncDirectory(temporaryDirectory);
        await this.beforeCommit?.("attempt", destination);
        await rename(temporaryDirectory, destination);
        temporaryDirectory = undefined;
        await chmod(destination, 0o700);
        await syncDirectory(attemptsDirectory);
      } catch (error) {
        throw asStoreError("Could not write evaluation attempt.", error);
      } finally {
        if (temporaryDirectory !== undefined) {
          await rm(temporaryDirectory, { force: true, recursive: true }).catch(() => undefined);
        }
        await lease.release();
      }
    });
  }

  public async writeDecision(decision: CompletionDecision): Promise<void> {
    validateCompletionDecision(decision);
    await this.enqueue(`decision:${decision.runId}:${decision.attemptId}`, async () => {
      await this.initialize();
      const lease = await this.lockManager.acquire(
        `decision:${decision.runId}:${decision.attemptId}`,
      );
      try {
        const attempt = await this.readAttempt(decision.runId, decision.attemptId);
        if (
          attempt === undefined ||
          attempt.scorecard.runId !== decision.runId ||
          attempt.scorecard.taskId !== decision.taskId
        ) {
          throw conflict("Evaluation decision does not belong to a stored attempt.");
        }
        const destination = join(
          this.attemptDir(decision.runId, decision.attemptId),
          "decision.json",
        );
        const existing = await readOptional(destination);
        if (existing !== undefined) {
          const stored = parseStoredDecision(
            parseStoredJson(existing, "Evaluation completion decision"),
          );
          if (stored.digest === decision.digest) {
            return;
          }
          throw conflict("Evaluation decision already exists with a different digest.");
        }
        await atomicWriteJson(destination, decision, "decision", this.beforeCommit);
      } finally {
        await lease.release();
      }
    });
  }

  public async readAttempt(
    runId: string,
    attemptId: string,
  ): Promise<EvalStoredAttempt | undefined> {
    await this.initialize();
    const directory = this.attemptDir(runId, attemptId);
    if (!(await pathExists(directory))) {
      return undefined;
    }
    try {
      const [attemptText, evidenceText, scorecardText, decisionText] = await Promise.all([
        readFile(join(directory, "attempt.json"), "utf8"),
        readFile(join(directory, "evidence-index.json"), "utf8"),
        readFile(join(directory, "scorecard.json"), "utf8"),
        readOptional(join(directory, "decision.json")),
      ]);
      const attempt = parseStoredEvalAttempt(parseStoredJson(attemptText, "Evaluation attempt"));
      const evidenceIndex = parseStoredEvidenceIndex(
        parseStoredJson(evidenceText, "Evaluation evidence index"),
      );
      const scorecard = parseStoredScorecard(
        parseStoredJson(scorecardText, "Evaluation scorecard"),
      );
      const decision =
        decisionText === undefined
          ? undefined
          : parseStoredDecision(parseStoredJson(decisionText, "Evaluation completion decision"));
      validateStoredRelationship(runId, attemptId, {
        attempt,
        evidenceIndex,
        scorecard,
        ...(decision !== undefined ? { decision } : {}),
      });
      return {
        attempt,
        evidenceIndex,
        scorecard,
        ...(decision !== undefined ? { decision } : {}),
      };
    } catch (error) {
      throw asStoreError("Could not read evaluation attempt.", error);
    }
  }

  public async listRuns(query: EvalRunQuery): Promise<readonly EvalRunSummary[]> {
    await this.initialize();
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100) {
      throw new EvaluationError(
        "EVAL_PROFILE_INVALID",
        "Evaluation run query limit must be between 1 and 100.",
      );
    }
    const entries = await readdir(join(this.rootDir, "runs"), { withFileTypes: true });
    const summaries: EvalRunSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const planText = await readOptional(join(this.rootDir, "runs", entry.name, "plan.json"));
      if (planText === undefined) {
        continue;
      }
      const plan = parseStoredEvalPlan(parseStoredJson(planText, "Evaluation plan"));
      if (query.profileId !== undefined && plan.profileId !== query.profileId) {
        continue;
      }
      const attempts = await this.readRunAttempts(plan.runId);
      const latest = attempts.at(-1);
      const decision = latest?.decision?.action;
      if (query.decision !== undefined && decision !== query.decision) {
        continue;
      }
      summaries.push({
        attemptCount: attempts.length,
        createdAt: plan.createdAt,
        ...(decision !== undefined ? { decision } : {}),
        profileId: plan.profileId,
        runId: plan.runId,
        taskId: plan.taskId,
        updatedAt: latest?.attempt.finishedAt ?? plan.createdAt,
      });
    }
    return Object.freeze(
      summaries
        .toSorted(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) || left.runId.localeCompare(right.runId),
        )
        .filter((summary) => query.cursor === undefined || summary.runId > query.cursor)
        .slice(0, query.limit)
        .map((summary) => Object.freeze(summary)),
    );
  }

  private async initializeNow(): Promise<void> {
    await assertNotSymlink(this.rootDir);
    await secureDirectory(this.rootDir);
    await Promise.all(
      ["baselines", "feedback", "runs"].map((name) => secureDirectory(join(this.rootDir, name))),
    );
    await this.lockManager.initialize();
  }

  private runDir(runId: string): string {
    return join(this.rootDir, "runs", storageKey(runId));
  }

  private attemptDir(runId: string, attemptId: string): string {
    return join(this.runDir(runId), "attempts", storageKey(attemptId));
  }

  private async readPlan(runId: string) {
    const text = await readOptional(join(this.runDir(runId), "plan.json"));
    return text === undefined
      ? undefined
      : parseStoredEvalPlan(parseStoredJson(text, "Evaluation plan"));
  }

  private async readRunAttempts(runId: string): Promise<readonly EvalStoredAttempt[]> {
    const directory = join(this.runDir(runId), "attempts");
    let entries: Dirent<string>[];
    try {
      entries = await readdir(directory, { encoding: "utf8", withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const attempts: EvalStoredAttempt[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const attemptText = await readOptional(join(directory, entry.name, "attempt.json"));
      if (attemptText === undefined) {
        continue;
      }
      const attempt = parseStoredEvalAttempt(parseStoredJson(attemptText, "Evaluation attempt"));
      const stored = await this.readAttempt(runId, attempt.attemptId);
      if (stored !== undefined) {
        attempts.push(stored);
      }
    }
    return attempts.toSorted((left, right) =>
      left.attempt.startedAt.localeCompare(right.attempt.startedAt),
    );
  }

  private enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const operationName = key.split(":", 1)[0] ?? "unknown";
    const startedAt = this.now();
    const previous = this.queues.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    void result.then(
      () => this.recordOperation(operationName, startedAt, "success"),
      (error: unknown) => this.recordOperation(operationName, startedAt, errorCode(error)),
    );
    const queueTail = result
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (this.queues.get(key) === queueTail) {
          this.queues.delete(key);
        }
      });
    this.queues.set(key, queueTail);
    return result;
  }

  private recordOperation(operation: string, startedAt: number, status: "success" | string): void {
    const durationMs = Math.max(0, this.now() - startedAt);
    observeEvalMetric(this.metrics, "eval_store_operation_ms", durationMs, {
      operation,
      ...(status === "success" ? { status: "success" } : {}),
    });
    if (status !== "success") {
      incrementEvalMetric(this.metrics, "eval_errors_total", {
        component: "store",
        errorCode: status,
      });
    }
    writeEvalLog(this.logger, {
      durationMs,
      ...(status !== "success" ? { errorCode: status } : {}),
      event: "evaluation.store.operation",
      level: status === "success" ? "debug" : "error",
      status,
      timestamp: new Date().toISOString(),
    });
  }
}

function validateAttemptCommit(commit: EvalAttemptCommit): void {
  validateEvalAttemptRecord(commit.attempt);
  validateEvalEvidenceIndex(commit.evidenceIndex);
  validateEvaluationScorecardDigest(commit.scorecard);
  if (
    commit.attempt.attemptId !== commit.evidenceIndex.attemptId ||
    commit.attempt.attemptId !== commit.scorecard.attemptId ||
    commit.attempt.scorecardDigest !== commit.scorecard.digest ||
    commit.attempt.planDigest !== commit.scorecard.planDigest
  ) {
    throw new EvaluationError(
      "EVAL_INVALID_RESULT",
      "Evaluation attempt commit contains inconsistent identifiers or digests.",
    );
  }
}

function validateStoredRelationship(
  runId: string,
  attemptId: string,
  stored: EvalStoredAttempt,
): void {
  validateAttemptCommit(stored);
  if (
    stored.attempt.attemptId !== attemptId ||
    stored.scorecard.runId !== runId ||
    (stored.decision !== undefined &&
      (stored.decision.attemptId !== attemptId ||
        stored.decision.runId !== runId ||
        stored.decision.taskId !== stored.scorecard.taskId))
  ) {
    throw new EvaluationError(
      "EVAL_STORE_CORRUPT",
      "Stored evaluation attempt contains inconsistent identifiers.",
    );
  }
}

async function atomicWriteJson(
  destination: string,
  value: unknown,
  operation: StoreOperation,
  beforeCommit:
    | ((operation: StoreOperation, destination: string) => Promise<void> | void)
    | undefined,
): Promise<void> {
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
  try {
    await writeNewJson(temporary, value);
    await beforeCommit?.(operation, destination);
    await rename(temporary, destination);
    await chmod(destination, 0o600);
    await syncDirectory(dirname(destination));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw asStoreError(`Could not commit ${operation} record.`, error);
  }
}

async function writeNewJson(filePath: string, value: unknown): Promise<void> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(filePath, "wx", 0o600);
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await chmod(filePath, 0o600);
  } catch (error) {
    await file?.close().catch(() => undefined);
    await rm(filePath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function secureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { mode: 0o700, recursive: true });
  await chmod(directory, 0o700);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertNotSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw unavailable("Evaluation store root must not be a symbolic link.");
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function readOptional(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function storageKey(value: string): string {
  return sha256Text(value);
}

function conflict(message: string): EvaluationError {
  return new EvaluationError("EVAL_STORE_CONFLICT", message);
}

function unavailable(message: string, cause?: unknown): EvaluationError {
  return new EvaluationError("EVAL_STORE_UNAVAILABLE", message, { cause });
}

function asStoreError(message: string, error: unknown): EvaluationError {
  return error instanceof EvaluationError ? error : unavailable(message, error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorCode(error: unknown): string {
  return error instanceof EvaluationError ? error.code : "EVAL_STORE_UNAVAILABLE";
}
