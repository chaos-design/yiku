import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentArtifactRef,
  type EvalExecutionContext,
  EvalPlanner,
  EvalScheduler,
  EvaluatorRegistry,
  sha256Digest,
  sha256Text,
  type VerificationCommand,
} from "@yiku/evals";
import type {
  ShellProcessSandbox,
  ShellSandboxLaunchInput,
  ShellSandboxLaunchSpec,
} from "@yiku/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodeArtifactIntegrityEvaluator,
  CodeChangeScopeEvaluator,
  CodeVerificationCommandEvaluator,
  createCodeEvalProfile,
  createCodeEvaluators,
  VerificationCommandRunner,
  WorkspaceContext,
} from "../../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("code evaluators", () => {
  it("runs generic, artifact, scope, and command checks end to end", async () => {
    const fixture = await evaluatorFixture(0, [artifact()]);
    const scorecard = await fixture.scheduler.run(fixture.plan, fixture.context);

    expect(scorecard.passed).toBe(true);
    expect(scorecard.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "code-artifact-integrity", status: "passed" }),
        expect.objectContaining({ id: "code-change-scope", status: "passed" }),
        expect.objectContaining({ id: "code-test-command", status: "passed" }),
      ]),
    );
  });

  it("blocks out-of-scope changes and skips dependent commands", async () => {
    const fixture = await evaluatorFixture(0, [artifact({ inScope: false })]);
    const scorecard = await fixture.scheduler.run(fixture.plan, fixture.context);

    expect(scorecard.hardGatePassed).toBe(false);
    expect(scorecard.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "code-change-scope", status: "failed" }),
        expect.objectContaining({
          errorCode: "EVAL_DEPENDENCY_FAILED",
          id: "code-test-command",
          status: "not-run",
        }),
      ]),
    );
  });

  it("detects artifact tampering and command failures", async () => {
    const invalid = {
      ...artifact(),
      digest: sha256Text("tampered"),
    };
    const integrityFixture = await evaluatorFixture(0, [invalid]);
    const integrity = await integrityFixture.scheduler.run(
      integrityFixture.plan,
      integrityFixture.context,
    );
    expect(integrity.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "code-artifact-integrity", status: "failed" }),
      ]),
    );

    const commandFixture = await evaluatorFixture(1, [artifact()]);
    const command = await commandFixture.scheduler.run(commandFixture.plan, commandFixture.context);
    expect(command.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          errorCode: "EVAL_COMMAND_FAILED",
          id: "code-test-command",
          status: "failed",
        }),
      ]),
    );
  });

  it("validates complete profile options, duplicate commands, and malformed command fields", () => {
    const valid = verificationCommand();
    const profile = createCodeEvalProfile({
      commands: [],
      id: "custom-code",
      maxConcurrentChecks: 2,
      maxRepairAttempts: 0,
      mode: "observe",
      qualityThreshold: 0.9,
      requireChanges: false,
      timeoutMs: 5_000,
    });
    expect(profile).toMatchObject({
      id: "custom-code",
      limits: {
        maxConcurrentChecks: 2,
        maxRepairAttempts: 0,
        timeoutMs: 5_000,
      },
      mode: "observe",
      qualityThreshold: 0.9,
    });
    expect(profile.checks.find((check) => check.id === "code-change-scope")?.config).toEqual({
      requireChanges: false,
    });
    expect(() => createCodeEvalProfile({ commands: [valid, valid] })).toThrow(
      "Duplicate verification command",
    );

    for (const invalid of [
      null,
      [],
      { ...valid, args: "invalid" },
      { ...valid, args: [1] },
      { ...valid, command: 1 },
      { ...valid, cwd: 1 },
      { ...valid, envAllowlist: "invalid" },
      { ...valid, envAllowlist: [1] },
      { ...valid, id: 1 },
      { ...valid, network: "invalid" },
      { ...valid, timeoutMs: 1.5 },
      { ...valid, writePolicy: "invalid" },
    ]) {
      expect(() =>
        createCodeEvalProfile({ commands: [invalid as unknown as VerificationCommand] }),
      ).toThrow("Verification command config");
    }
  });

  it("handles invalid artifact paths, duplicate paths, and empty change policies", async () => {
    const fixture = await evaluatorFixture(0, []);
    const integrityCheck = fixture.plan.checks.find(
      (check) => check.id === "code-artifact-integrity",
    );
    const scopeCheck = fixture.plan.checks.find((check) => check.id === "code-change-scope");
    if (integrityCheck === undefined || scopeCheck === undefined) {
      throw new Error("Expected code evaluator checks.");
    }
    const missingPath = artifact();
    const { path: _path, ...invalidMetadata } = missingPath.metadata;
    const duplicate = artifact();
    const integrity = new CodeArtifactIntegrityEvaluator().evaluate(integrityCheck, {
      ...fixture.context,
      artifacts: [
        {
          ...missingPath,
          digest: sha256Digest(invalidMetadata),
          metadata: invalidMetadata,
        },
        duplicate,
        { ...duplicate, id: "duplicate" },
      ],
    });
    expect(integrity).toMatchObject({
      passed: false,
      summary: expect.stringContaining("invalid artifact"),
    });
    expect(integrity.summary).toContain("duplicate path");

    const scope = new CodeChangeScopeEvaluator();
    expect(scope.evaluate(scopeCheck, fixture.context)).toMatchObject({
      passed: false,
      summary: "No code changes were captured.",
    });
    expect(
      scope.evaluate({ ...scopeCheck, config: { requireChanges: false } }, fixture.context),
    ).toMatchObject({ passed: true });
  });

  it("maps command timeout, signal, and empty output into stable check results", async () => {
    const fixture = await evaluatorFixture(0, [artifact()]);
    const check = fixture.plan.checks.find((candidate) => candidate.id === "code-test-command");
    if (check === undefined) {
      throw new Error("Expected verification command check.");
    }
    const execution = {
      artifact: {
        digest: sha256Text("artifact"),
        id: "command-artifact",
        kind: "command-result" as const,
        metadata: {},
        sizeBytes: 0,
        storageRef: "command:test",
      },
      command: verificationCommand(),
      durationMs: 1,
      outputDigest: sha256Text("output"),
      stderrHead: "",
      stderrTail: "",
      stdoutHead: "",
      stdoutTail: "",
      timedOut: true,
    };
    const timeoutEvaluator = new CodeVerificationCommandEvaluator({
      run: async () => execution,
    } as unknown as VerificationCommandRunner);
    expect(await timeoutEvaluator.evaluate(check, fixture.context)).toMatchObject({
      errorCode: "EVAL_TIMEOUT",
      retryable: false,
      status: "error",
    });

    const signalEvaluator = new CodeVerificationCommandEvaluator({
      run: async () => ({ ...execution, signal: "SIGTERM" as const, timedOut: false }),
    } as unknown as VerificationCommandRunner);
    expect(await signalEvaluator.evaluate(check, fixture.context)).toMatchObject({
      errorCode: "EVAL_COMMAND_SIGNALLED",
      retryable: true,
      status: "failed",
    });
  });
});

async function evaluatorFixture(exitCode: number, artifacts: readonly AgentArtifactRef[]) {
  const root = await workspace();
  const runner = new VerificationCommandRunner({
    sandbox: new DirectSandbox(),
    workspace: new WorkspaceContext({ rootDir: root }),
  });
  const evaluators = createCodeEvaluators(runner);
  const registry = new EvaluatorRegistry(evaluators);
  const command: VerificationCommand = {
    args: ["-e", `process.exit(${exitCode})`],
    command: process.execPath,
    cwd: ".",
    envAllowlist: [],
    id: "test-command",
    network: "deny",
    timeoutMs: 1_000,
    writePolicy: "read-only",
  };
  const plan = new EvalPlanner({
    clock: () => new Date("2026-08-13T00:00:00.000Z"),
    registry,
  }).createPlan({
    profile: createCodeEvalProfile({
      commands: [command],
      maxRepairAttempts: 0,
      timeoutMs: 2_000,
    }),
    runId: "run",
    taskId: "task",
  });
  const output = "done";
  const context: EvalExecutionContext = {
    artifacts,
    attemptId: "attempt",
    finalOutput: output,
    finalOutputDigest: sha256Text(output),
    flow: {
      degraded: false,
      degradationCodes: [],
      events: [],
      runId: "run",
    },
    flowRef: "flow:run",
    operationReceipts: [],
    runId: "run",
    runtimeMetrics: {
      durationMs: 100,
      peakRssBytes: 1024,
    },
    taskId: "task",
    taskSnapshotRef: "task:task",
  };
  return {
    context,
    plan,
    scheduler: new EvalScheduler({ registry }),
  };
}

function artifact(
  overrides: Partial<Record<"externalSymlink" | "inScope", boolean>> = {},
): AgentArtifactRef {
  const metadata = {
    afterDigest: sha256Text("after"),
    beforeDigest: sha256Text("before"),
    changeType: "modified",
    externalSymlink: overrides.externalSymlink ?? false,
    inScope: overrides.inScope ?? true,
    mode: 0o644,
    path: "src/index.ts",
    type: "file",
  };
  return {
    digest: sha256Digest(metadata),
    id: `file-${sha256Text("src/index.ts")}`,
    kind: "file-change",
    metadata,
    sizeBytes: 10,
    storageRef: "workspace:src/index.ts",
  };
}

class DirectSandbox implements ShellProcessSandbox {
  public readonly isolation = "sandbox" as const;
  public readonly network = "deny" as const;

  public close(): void {}

  public createLaunchSpec(input: ShellSandboxLaunchInput): ShellSandboxLaunchSpec {
    return {
      args: [],
      command: input.shellPath,
      cwd: input.cwd ?? input.workspace.rootDir,
      environment: input.environment,
    };
  }
}

async function workspace(): Promise<string> {
  const directory = join(
    tmpdir(),
    `yiku-code-evaluator-${process.pid}-${Date.now()}-${temporaryDirectories.length}`,
  );
  await mkdir(directory, { mode: 0o700 });
  temporaryDirectories.push(directory);
  return directory;
}

function verificationCommand(): VerificationCommand {
  return {
    args: ["-e", "process.exit(0)"],
    command: process.execPath,
    cwd: ".",
    envAllowlist: [],
    id: "test-command",
    network: "deny",
    timeoutMs: 1_000,
    writePolicy: "read-only",
  };
}
