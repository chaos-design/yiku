import { AtomicFlowRun } from "@yiku/atomic-flow";
import { describe, expect, it } from "vitest";
import { ResearchFlowTracker } from "../../src/flow/research-flow-tracker.js";

describe("ResearchFlowTracker", () => {
  it("emits the complete evidence-led Research lifecycle", () => {
    const flow = new AtomicFlowRun({
      eventIdGenerator: sequence("event"),
      instanceIdGenerator: sequence("instance"),
      runId: "research-run",
    });
    const tracker = new ResearchFlowTracker(flow);

    tracker.begin("Research current Agent observability trends.");
    tracker.toolCalled({
      callId: "search-1",
      summary: "official Agent observability specifications",
      toolName: "web_search_call",
    });
    tracker.recordEvidence({
      accessedAt: "2026-08-11T00:00:00.000Z",
      claims: ["The specification defines trace semantics."],
      id: "evidence-1",
      sourceType: "primary",
      title: "Official specification",
      url: "https://example.com/specification",
      verification: "single-source",
    });
    tracker.toolOutput({
      callId: "search-1",
      summary: "Search completed",
      toolName: "web_search_call",
    });
    tracker.beginSynthesis();
    tracker.finishReport("# Report", {
      diagnostics: [],
      evidenceCount: 1,
      passed: true,
      primarySourceCount: 1,
    });

    const events = flow.snapshot().events;
    expect(events.map((event) => `${event.atom.key}:${event.phase}`)).toEqual([
      "research.plan:start",
      "research.plan:end",
      "research.query:start",
      "research.query:end",
      "research.search:start",
      "research.evidence-record:start",
      "research.evidence-record:end",
      "research.search:end",
      "research.corroborate:start",
      "research.corroborate:end",
      "research.synthesize:start",
      "research.synthesize:end",
      "research.citation-validate:start",
      "research.citation-validate:end",
      "research.report:start",
      "research.report:end",
    ]);
    expect(
      events.find((event) => event.atom.key === "research.evidence-record" && event.phase === "end")
        ?.payload,
    ).toMatchObject({
      counts: {
        claims: 1,
        evidence: 1,
      },
      values: {
        evidenceId: "evidence-1",
        sourceType: "primary",
      },
    });
    expect(events.at(-1)?.payload).toMatchObject({
      counts: {
        characters: 8,
        evidence: 1,
      },
      values: {
        passed: true,
      },
    });
  });

  it("fails open stages and emits validation diagnostics without inventing success", () => {
    const flow = new AtomicFlowRun({
      eventIdGenerator: sequence("event"),
      instanceIdGenerator: sequence("instance"),
      runId: "failed-research-run",
    });
    const tracker = new ResearchFlowTracker(flow);

    tracker.begin("Research safely.");
    tracker.toolCalled({ toolName: "web-search" });
    tracker.fail(new Error("Search provider unavailable"));

    expect(flow.snapshot().events.at(-1)).toMatchObject({
      atom: {
        key: "research.search",
      },
      payload: {
        code: "RESEARCH_SEARCH_FAILED",
        summary: "Search provider unavailable",
      },
      phase: "error",
    });

    const validationFlow = new AtomicFlowRun({
      eventIdGenerator: sequence("validation-event"),
      instanceIdGenerator: sequence("validation-instance"),
      runId: "invalid-report-run",
    });
    const validationTracker = new ResearchFlowTracker(validationFlow);
    validationTracker.begin("Research with evidence.");
    validationTracker.finishReport("Unsupported.", {
      diagnostics: ["No evidence."],
      evidenceCount: 0,
      passed: false,
      primarySourceCount: 0,
    });

    expect(
      validationFlow
        .snapshot()
        .events.find(
          (event) => event.atom.key === "research.citation-validate" && event.phase === "error",
        ),
    ).toMatchObject({
      payload: {
        code: "RESEARCH_CITATION_VALIDATION_FAILED",
        counts: {
          diagnostics: 1,
        },
        values: {
          passed: false,
        },
      },
    });
  });

  it("handles implicit lifecycle, fallback search identities, and idempotent stages", () => {
    const flow = new AtomicFlowRun({
      eventIdGenerator: sequence("implicit-event"),
      instanceIdGenerator: sequence("implicit-instance"),
      runId: "implicit-run",
    });
    const tracker = new ResearchFlowTracker(flow);
    tracker.toolCalled({ toolName: "terminal" });
    tracker.toolOutput({ toolName: "terminal" });
    tracker.toolOutput({ toolName: "web_search" });
    tracker.begin("x".repeat(300));
    tracker.begin("ignored duplicate");
    tracker.toolCalled({ toolName: "WEBSEARCH" });
    tracker.toolOutput({
      callId: "missing",
      toolName: "web_search",
    });
    tracker.recordEvidence(evidence("one", "single-source"));
    tracker.toolOutput({ toolName: "web_search" });
    tracker.recordEvidence(evidence("two", "single-source"));
    tracker.recordEvidence(evidence("three", "corroborated"));
    tracker.recordEvidence(evidence("four", "corroborated"));
    tracker.toolCalled({
      callId: "open",
      summary: "Open search",
      toolName: "web-search",
    });
    tracker.beginSynthesis();
    tracker.beginSynthesis();
    tracker.fail("synthesis failed");

    const events = flow.snapshot().events;
    expect(
      events.find((event) => event.atom.key === "research.plan" && event.phase === "end")?.payload
        .summary,
    ).toHaveLength(240);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          atom: expect.objectContaining({ key: "research.search" }),
          payload: expect.objectContaining({ summary: "Search stream completed" }),
          phase: "end",
        }),
        expect.objectContaining({
          atom: expect.objectContaining({ key: "research.corroborate" }),
          payload: expect.objectContaining({
            counts: { evidence: 3 },
          }),
          phase: "end",
        }),
        expect.objectContaining({
          atom: expect.objectContaining({ key: "research.synthesize" }),
          payload: expect.objectContaining({
            code: "RESEARCH_SYNTHESIS_FAILED",
            summary: "synthesis failed",
          }),
          phase: "error",
        }),
      ]),
    );
  });

  it("links evidence directly to an implicit plan and reviews single-evidence limitations", () => {
    const flow = new AtomicFlowRun({
      eventIdGenerator: sequence("direct-event"),
      instanceIdGenerator: sequence("direct-instance"),
      runId: "direct-run",
    });
    const tracker = new ResearchFlowTracker(flow);
    tracker.recordEvidence(evidence("direct", "single-source"));
    tracker.finishReport("Report", {
      diagnostics: [],
      evidenceCount: 1,
      passed: true,
      primarySourceCount: 0,
    });

    const events = flow.snapshot().events;
    const evidenceStart = events.find(
      (event) => event.atom.key === "research.evidence-record" && event.phase === "start",
    );
    expect(evidenceStart?.edge).toMatchObject({
      fromAtomKey: "research.plan",
    });
    expect(
      events.find((event) => event.atom.key === "research.corroborate" && event.phase === "end")
        ?.payload.summary,
    ).toBe("Evidence limitations reviewed");
  });
});

function evidence(id: string, verification: "corroborated" | "single-source") {
  return {
    accessedAt: "2026-08-13T00:00:00.000Z",
    claims: [`Claim ${id}`],
    id: `evidence-${id}`,
    sourceType: "secondary" as const,
    title: `Evidence ${id}`,
    url: `https://example.com/${id}`,
    verification,
  };
}

function sequence(prefix: string): () => string {
  let index = 0;
  return () => {
    index += 1;
    return `${prefix}-${index}`;
  };
}
