import { describe, expect, it } from "vitest";
import {
  parseStoredDecision,
  parseStoredEvalAttempt,
  parseStoredEvalPlan,
  parseStoredEvidenceIndex,
  parseStoredJson,
  parseStoredScorecard,
} from "../../src/store/schema.js";
import { storedFixture } from "./fixtures.js";

describe("evaluation store schemas", () => {
  it("parses valid records and rejects malformed JSON and versions", async () => {
    const fixture = await storedFixture();
    expect(parseStoredEvalPlan(fixture.plan)).toEqual(fixture.plan);
    expect(parseStoredEvalAttempt(fixture.commit.attempt)).toEqual(fixture.commit.attempt);
    expect(parseStoredEvidenceIndex(fixture.commit.evidenceIndex)).toEqual(
      fixture.commit.evidenceIndex,
    );
    expect(parseStoredScorecard(fixture.commit.scorecard)).toEqual(fixture.commit.scorecard);
    expect(parseStoredDecision(fixture.decision)).toEqual(fixture.decision);
    expect(() => parseStoredJson("{", "Record")).toThrow("valid JSON");
    for (const parse of [
      parseStoredEvalPlan,
      parseStoredEvalAttempt,
      parseStoredEvidenceIndex,
      parseStoredScorecard,
      parseStoredDecision,
    ]) {
      expect(() => parse({ version: 2 })).toThrowError(
        expect.objectContaining({ code: "EVAL_SCHEMA_UNSUPPORTED" }),
      );
      expect(() => parse(null)).toThrowError(
        expect.objectContaining({ code: "EVAL_STORE_CORRUPT" }),
      );
    }
  });

  it("rejects inconsistent scorecard scalars, dimensions, results, and counts", async () => {
    const { scorecard } = (await storedFixture()).commit;
    const mutations: unknown[] = [
      { ...scorecard, attemptId: "" },
      { ...scorecard, digest: "invalid" },
      { ...scorecard, averageScore: -1 },
      { ...scorecard, overallScore: 2 },
      { ...scorecard, passed: "true" },
      { ...scorecard, passed: !scorecard.qualityPassed },
      { ...scorecard, grade: "D" },
      { ...scorecard, dimensionScores: null },
      {
        ...scorecard,
        dimensionScores: { ...scorecard.dimensionScores, correctness: 2 },
      },
      { ...scorecard, results: null },
      { ...scorecard, counts: { ...scorecard.counts, passed: 999 } },
      {
        ...scorecard,
        results: [
          {
            ...scorecard.results[0],
            dimension: "invalid",
          },
          ...scorecard.results.slice(1),
        ],
      },
      {
        ...scorecard,
        results: [
          {
            ...scorecard.results[0],
            severity: "invalid",
          },
          ...scorecard.results.slice(1),
        ],
      },
      {
        ...scorecard,
        results: [
          {
            ...scorecard.results[0],
            status: "invalid",
          },
          ...scorecard.results.slice(1),
        ],
      },
      {
        ...scorecard,
        results: [
          {
            ...scorecard.results[0],
            passed: false,
          },
          ...scorecard.results.slice(1),
        ],
      },
      {
        ...scorecard,
        results: [
          {
            ...scorecard.results[0],
            durationMs: -1,
          },
          ...scorecard.results.slice(1),
        ],
      },
      {
        ...scorecard,
        results: [
          {
            ...scorecard.results[0],
            evidenceRefs: [""],
          },
          ...scorecard.results.slice(1),
        ],
      },
      {
        ...scorecard,
        results: [
          {
            ...scorecard.results[0],
            errorCode: undefined,
            passed: false,
            status: "error",
          },
          ...scorecard.results.slice(1),
        ],
      },
      {
        ...scorecard,
        results: [
          {
            ...scorecard.results[0],
            required: "true",
          },
          ...scorecard.results.slice(1),
        ],
      },
      {
        ...scorecard,
        results: [
          {
            ...scorecard.results[0],
            score: 2,
          },
          ...scorecard.results.slice(1),
        ],
      },
    ];
    for (const mutation of mutations) {
      expect(() => parseStoredScorecard(mutation)).toThrowError(
        expect.objectContaining({ code: "EVAL_STORE_CORRUPT" }),
      );
    }
    expect(() =>
      parseStoredScorecard({
        ...scorecard,
        results: [
          {
            ...scorecard.results[0],
            version: 2,
          },
          ...scorecard.results.slice(1),
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "EVAL_SCHEMA_UNSUPPORTED" }));
  });
});
