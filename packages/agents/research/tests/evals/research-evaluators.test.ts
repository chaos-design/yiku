import {
  EvalPlanner,
  EvalScheduler,
  EvaluationError,
  EvaluatorRegistry,
  sha256Text,
} from "@yiku/evals";
import { describe, expect, it } from "vitest";
import {
  createResearchEvalProfile,
  createResearchEvaluators,
  ResearchContradictionEvaluator,
  ResearchDiversityEvaluator,
  ResearchFreshnessEvaluator,
  ResearchReportStructureEvaluator,
  ResearchSourceAuthorityEvaluator,
  researchEvidenceArtifacts,
  researchReportArtifact,
} from "../../src/evals/research-evaluators.js";
import { ResearchClaimLedger } from "../../src/evidence/claim-ledger.js";
import { EvidenceLedger } from "../../src/evidence/evidence-ledger.js";

describe("research evaluators", () => {
  it("evaluates claim citations, authority, freshness, diversity, and contradictions", async () => {
    const fixture = researchFixture();
    const scorecard = await fixture.scheduler.run(fixture.plan, fixture.context);

    expect(scorecard.passed).toBe(true);
    expect(scorecard.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "research-claim-citation", score: 1, status: "passed" }),
        expect.objectContaining({ id: "research-source-authority", status: "passed" }),
        expect.objectContaining({ id: "research-freshness", status: "passed" }),
        expect.objectContaining({ id: "research-diversity", status: "passed" }),
        expect.objectContaining({ id: "research-contradiction", status: "passed" }),
      ]),
    );
    expect(researchReportArtifact(fixture.context.finalOutput)).toMatchObject({
      kind: "research-report",
      sizeBytes: expect.any(Number),
    });
  });

  it("detects a changed Claim Manifest and skips dependent research checks", async () => {
    const fixture = researchFixture();
    const scorecard = await fixture.scheduler.run(fixture.plan, {
      ...fixture.context,
      researchClaimManifest: {
        ...fixture.context.researchClaimManifest,
        digest: sha256Text("tampered"),
      },
    });

    expect(scorecard.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          errorCode: "EVAL_ARTIFACT_CHANGED",
          id: "research-claim-citation",
          status: "error",
        }),
        expect.objectContaining({
          errorCode: "EVAL_DEPENDENCY_FAILED",
          id: "research-source-authority",
          status: "not-run",
        }),
      ]),
    );
  });

  it("fails unsupported and stale structured claims", async () => {
    const fixture = researchFixture({
      report: [
        "The API was released.",
        "An independent source disputes the date. https://independent.test/report",
      ].join("\n\n"),
    });
    const scorecard = await fixture.scheduler.run(fixture.plan, fixture.context);

    expect(scorecard.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "research-claim-citation", status: "failed" }),
      ]),
    );
    expect(scorecard.passed).toBe(false);
  });

  it("requires an immutable Claim Manifest and checks both manifest digests", () => {
    const fixture = researchFixture();
    const check = fixture.plan.checks.find(
      (candidate) => candidate.id === "research-claim-citation",
    );
    const evaluator = createResearchEvaluators(fixture.evidenceLedger, fixture.claimLedger).find(
      (candidate) => candidate.descriptor.key === "research-claim-citation",
    );
    if (check === undefined || evaluator === undefined) {
      throw new Error("Expected claim citation evaluator.");
    }
    expect(() =>
      evaluator.evaluate(check, {
        ...fixture.context,
        researchClaimManifest: undefined,
      }),
    ).toThrowError(expect.objectContaining({ code: "EVAL_EVIDENCE_MISSING" }));
    expect(() =>
      evaluator.evaluate(check, {
        ...fixture.context,
        researchClaimManifest: {
          ...fixture.context.researchClaimManifest,
          reportDigest: sha256Text("other-report"),
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "EVAL_ARTIFACT_CHANGED" }));
  });

  it("covers failed domain metrics, default thresholds, and invalid score configuration", () => {
    const fixture = researchFixture({ report: "The API was released." });
    const findCheck = (id: string) => {
      const check = fixture.plan.checks.find((candidate) => candidate.id === id);
      if (check === undefined) {
        throw new Error(`Expected ${id} check.`);
      }
      return check;
    };
    expect(
      new ResearchReportStructureEvaluator(fixture.evidenceLedger).evaluate(
        findCheck("research-report-structure"),
        { ...fixture.context, finalOutput: "" },
      ),
    ).toMatchObject({ passed: false, score: 0 });
    expect(
      new ResearchFreshnessEvaluator(fixture.evidenceLedger, fixture.claimLedger, {
        freshnessDays: 1,
        now: new Date("2026-08-13T00:00:00.000Z"),
      }).evaluate(findCheck("research-freshness"), fixture.context),
    ).toMatchObject({ passed: false });
    expect(
      new ResearchContradictionEvaluator(fixture.evidenceLedger, fixture.claimLedger).evaluate(
        findCheck("research-contradiction"),
        fixture.context,
      ),
    ).toMatchObject({ passed: false });

    const authority = new ResearchSourceAuthorityEvaluator(
      fixture.evidenceLedger,
      fixture.claimLedger,
    );
    expect(
      authority.evaluate(
        { ...findCheck("research-source-authority"), config: {} },
        fixture.context,
      ),
    ).toMatchObject({ passed: false });
    for (const minimumScore of ["invalid", Number.NaN, -1, 2]) {
      expect(() =>
        authority.evaluate(
          {
            ...findCheck("research-source-authority"),
            config: { minimumScore },
          },
          fixture.context,
        ),
      ).toThrow(EvaluationError);
    }
    expect(
      new ResearchDiversityEvaluator(fixture.evidenceLedger, fixture.claimLedger).evaluate(
        { ...findCheck("research-diversity"), config: {} },
        fixture.context,
      ),
    ).toMatchObject({ score: expect.any(Number) });
  });

  it("applies every Research profile option and records evidence without publication dates", () => {
    const profile = createResearchEvalProfile({
      freshnessDays: 7,
      id: "research-custom",
      maxConcurrentChecks: 2,
      maxRepairAttempts: 1,
      minimumIndependentDomains: 3,
      mode: "observe",
      qualityThreshold: 0.95,
      timeoutMs: 4_000,
    });
    expect(profile).toMatchObject({
      id: "research-custom",
      limits: {
        maxConcurrentChecks: 2,
        maxRepairAttempts: 1,
        timeoutMs: 4_000,
      },
      mode: "observe",
      qualityThreshold: 0.95,
    });

    const ledger = new EvidenceLedger();
    ledger.record({
      claims: ["Undated"],
      sourceType: "secondary",
      title: "Undated source",
      url: "https://example.com/undated",
      verification: "single-source",
    });
    expect(researchEvidenceArtifacts(ledger)[0]?.metadata.publishedAt).toBe("");
    expect(createResearchEvalProfile()).toMatchObject({
      id: "research-default",
      limits: {
        maxRepairAttempts: 1,
      },
      mode: "enforce",
    });
  });
});

function researchFixture(options: { readonly report?: string } = {}) {
  const evidenceLedger = new EvidenceLedger();
  const official = evidenceLedger.record({
    claims: ["The API was released."],
    publishedAt: "2026-08-01T00:00:00.000Z",
    sourceType: "primary",
    title: "Official release",
    url: "https://official.example/release",
    verification: "corroborated",
  });
  const independent = evidenceLedger.record({
    claims: ["An independent source disputes the date."],
    publishedAt: "2026-08-02T00:00:00.000Z",
    sourceType: "independent",
    title: "Independent report",
    url: "https://independent.test/report",
    verification: "corroborated",
  });
  const claimLedger = new ResearchClaimLedger({ evidenceLedger });
  const first = claimLedger.record({
    citationUrls: [official.url],
    evidenceIds: [official.id],
    statement: "The API was released.",
    temporal: true,
  });
  claimLedger.record({
    citationUrls: [independent.url],
    contradictsClaimIds: [first.id],
    evidenceIds: [independent.id],
    statement: "An independent source disputes the date.",
    temporal: true,
  });
  const report =
    options.report ??
    [
      "The API was released. https://official.example/release",
      "An independent source disputes the date. https://independent.test/report",
    ].join("\n\n");
  const evaluators = createResearchEvaluators(evidenceLedger, claimLedger, {
    freshnessDays: 30,
    minimumIndependentDomains: 2,
    now: new Date("2026-08-13T00:00:00.000Z"),
  });
  const registry = new EvaluatorRegistry(evaluators);
  const plan = new EvalPlanner({
    clock: () => new Date("2026-08-13T00:00:00.000Z"),
    registry,
  }).createPlan({
    profile: createResearchEvalProfile({
      maxRepairAttempts: 0,
      timeoutMs: 2_000,
    }),
    runId: "run",
    taskId: "task",
  });
  return {
    context: {
      artifacts: [researchReportArtifact(report)],
      attemptId: "attempt",
      finalOutput: report,
      finalOutputDigest: sha256Text(report),
      flow: {
        degraded: false,
        degradationCodes: [],
        events: [],
        runId: "run",
      },
      flowRef: "flow:run",
      operationReceipts: [],
      researchClaimManifest: claimLedger.manifest(report),
      runId: "run",
      runtimeMetrics: {
        durationMs: 100,
        peakRssBytes: 1024,
      },
      taskId: "task",
      taskSnapshotRef: "task:task",
    },
    claimLedger,
    evidenceLedger,
    plan,
    scheduler: new EvalScheduler({ registry }),
  };
}
