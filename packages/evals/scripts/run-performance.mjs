import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { cpus, freemem, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  createEvalAttemptRecord,
  createEvalEvidenceIndex,
  DEFAULT_DIMENSION_WEIGHTS,
  EvalPlanner,
  EvalScheduler,
  EvaluatorRegistry,
  FileEvalResultStore,
  MAX_EVAL_INPUT_BYTES,
  sha256Digest,
  sha256Text,
} from "../dist/index.js";

const SAMPLE_COUNT = 30;
const WARMUP_COUNT = 5;
const CONCURRENT_RUNS = 8;
const CHECKS_PER_RUN = 32;
const LARGE_INPUT_BYTES = 10 * 1024 * 1024 - 16 * 1024;
const outputPath = parseOutputPath(process.argv.slice(2));
const output = "x".repeat(LARGE_INPUT_BYTES);
const evaluator = syntheticEvaluator();
const registry = new EvaluatorRegistry([evaluator]);
const scheduler = new EvalScheduler({ maxConcurrentRuns: CONCURRENT_RUNS, registry });
const planner = new EvalPlanner({
  clock: () => new Date("2026-08-13T00:00:00.000Z"),
  registry,
});
const profile = performanceProfile();
const plan = planner.createPlan({
  profile,
  runId: "benchmark-run",
  taskId: "benchmark-task",
});
const context = evaluationContext("benchmark-run", "benchmark-task", "benchmark-attempt", output);

for (let index = 0; index < WARMUP_COUNT; index += 1) {
  await scheduler.run(plan, context);
}

const rssBefore = process.memoryUsage().rss;
const cpuBefore = process.cpuUsage();
const schedulerSamples = [];
let rssPeak = rssBefore;
for (let index = 0; index < SAMPLE_COUNT; index += 1) {
  const started = performance.now();
  await scheduler.run(plan, context);
  schedulerSamples.push(performance.now() - started);
  rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
}
const cpuUsage = process.cpuUsage(cpuBefore);

const concurrentSamples = [];
for (let sample = 0; sample < 10; sample += 1) {
  const started = performance.now();
  await Promise.all(
    Array.from({ length: CONCURRENT_RUNS }, (_, index) => {
      const runId = `concurrent-${sample}-${index}`;
      const taskId = `task-${sample}-${index}`;
      return scheduler.run(
        planner.createPlan({ profile, runId, taskId }),
        evaluationContext(runId, taskId, `attempt-${sample}-${index}`, "done"),
      );
    }),
  );
  concurrentSamples.push(performance.now() - started);
  rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
}

const storeRoot = join(tmpdir(), `yiku-eval-performance-${process.pid}-${Date.now()}`);
const store = new FileEvalResultStore({ rootDir: storeRoot });
const storeSamples = [];
try {
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const storePlan = planner.createPlan({
      profile,
      runId: `store-run-${index}`,
      taskId: `store-task-${index}`,
    });
    const started = performance.now();
    await store.writePlan(storePlan);
    storeSamples.push(performance.now() - started);
  }
  await store.writePlan(plan);
  const scorecard = await scheduler.run(plan, context);
  const attempt = createEvalAttemptRecord({
    attemptId: context.attemptId,
    contextDigest: sha256Digest({ benchmark: true }),
    finishedAt: "2026-08-13T00:00:01.000Z",
    planDigest: plan.digest,
    scorecardDigest: scorecard.digest,
    startedAt: "2026-08-13T00:00:00.000Z",
  });
  const attemptStarted = performance.now();
  await store.writeAttempt({
    attempt,
    evidenceIndex: createEvalEvidenceIndex(context.attemptId, []),
    scorecard,
  });
  storeSamples.push(performance.now() - attemptStarted);

  const persistedBytes = await directoryBytes(storeRoot);
  const report = {
    environment: {
      cpu: cpus()[0]?.model ?? "unknown",
      cpuCount: cpus().length,
      freeMemoryBytes: freemem(),
      node: process.version,
      operatingSystem: `${platform()} ${release()}`,
      totalMemoryBytes: totalmem(),
    },
    input: {
      checksPerRun: CHECKS_PER_RUN,
      concurrentRuns: CONCURRENT_RUNS,
      largeInputBytes: Buffer.byteLength(output, "utf8"),
      samples: SAMPLE_COUNT,
      warmups: WARMUP_COUNT,
    },
    measuredAt: new Date().toISOString(),
    results: {
      concurrentBatchMs: statistics(concurrentSamples),
      cpuMs: {
        system: cpuUsage.system / 1_000,
        user: cpuUsage.user / 1_000,
      },
      persistedBytes,
      rssDeltaBytes: Math.max(0, rssPeak - rssBefore),
      schedulerMs: statistics(schedulerSamples),
      storeCommitMs: statistics(storeSamples),
      throughputRunsPerSecond: (CONCURRENT_RUNS * 1_000) / average(concurrentSamples),
    },
    targets: {
      rssDeltaBytes: 256 * 1024 * 1024,
      schedulerP95Ms: 100,
      storeCommitP95Ms: 50,
    },
    version: 1,
  };
  report.passed =
    report.results.schedulerMs.p95 < report.targets.schedulerP95Ms &&
    report.results.storeCommitMs.p95 < report.targets.storeCommitP95Ms &&
    report.results.rssDeltaBytes < report.targets.rssDeltaBytes;

  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath !== undefined) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, serialized, "utf8");
  }
  process.stdout.write(serialized);
  if (!report.passed) {
    process.exitCode = 1;
  }
} finally {
  await rm(storeRoot, { force: true, recursive: true });
}

function performanceProfile() {
  const dimensions = ["correctness", "safety-reliability", "performance", "resource-efficiency"];
  return {
    checks: Array.from({ length: CHECKS_PER_RUN }, (_, index) => ({
      capability: "synthetic",
      config: {},
      dependsOn: [],
      dimension: dimensions[index % dimensions.length],
      evaluator: "synthetic",
      evidenceRequired: false,
      id: `check-${index}`,
      required: true,
      severity: "error",
      timeoutMs: 1_000,
      weight: 1,
    })),
    dimensionWeights: DEFAULT_DIMENSION_WEIGHTS,
    id: "performance",
    limits: {
      maxConcurrentChecks: 4,
      maxInputBytes: MAX_EVAL_INPUT_BYTES,
      maxRepairAttempts: 0,
      timeoutMs: 5_000,
    },
    mode: "enforce",
    qualityThreshold: 0.8,
    version: 1,
  };
}

function syntheticEvaluator() {
  return {
    descriptor: {
      capability: "synthetic",
      deterministic: true,
      key: "synthetic",
      label: "Synthetic",
      version: "1.0.0",
    },
    evaluate(check) {
      return {
        dimension: check.dimension,
        durationMs: 0,
        evaluator: check.evaluator,
        evidenceRefs: [],
        id: check.id,
        label: check.id,
        passed: true,
        required: check.required,
        retryable: false,
        score: 1,
        severity: check.severity,
        status: "passed",
        summary: "Passed.",
        version: 1,
      };
    },
  };
}

function evaluationContext(runId, taskId, attemptId, finalOutput) {
  return {
    artifacts: [],
    attemptId,
    finalOutput,
    finalOutputDigest: sha256Text(finalOutput),
    flow: {
      degraded: false,
      degradationCodes: [],
      events: [],
      runId,
    },
    flowRef: `flow:${runId}`,
    operationReceipts: [],
    runId,
    taskId,
    taskSnapshotRef: `task:${taskId}`,
  };
}

function statistics(samples) {
  return {
    max: Math.max(...samples),
    mean: average(samples),
    min: Math.min(...samples),
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
  };
}

function average(samples) {
  return samples.reduce((total, value) => total + value, 0) / samples.length;
}

function percentile(samples, ratio) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * ratio) - 1] ?? 0;
}

async function directoryBytes(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    total += entry.isDirectory() ? await directoryBytes(path) : (await stat(path)).size;
  }
  return total;
}

function parseOutputPath(args) {
  const index = args.indexOf("--output");
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value) {
    throw new Error("--output requires a file path.");
  }
  return resolve(value);
}
