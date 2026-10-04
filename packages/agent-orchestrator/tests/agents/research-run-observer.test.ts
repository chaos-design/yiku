import { EvidenceLedger } from "@yiku/agent-research";
import { AtomicFlowRun } from "@yiku/atomic-flow";
import { describe, expect, it, vi } from "vitest";
import { ResearchRunObserver } from "../../src/agents/research-run-observer.js";

describe("ResearchRunObserver", () => {
  it("maps Search, Evidence, Validation, and Report into one Research flow", () => {
    const flow = new AtomicFlowRun({ runId: "research-observer" });
    const ledger = new EvidenceLedger();
    const observer = new ResearchRunObserver({
      context: context(flow),
      ledger,
    });

    observer.start();
    observer.progress({
      callId: "search-1",
      summary: "official release",
      title: "Web Search",
      toolName: "web_search_call",
      type: "tool_called",
    });
    ledger.record({
      claims: ["The API was released."],
      sourceType: "primary",
      title: "Official release",
      url: "https://example.com/release",
      verification: "single-source",
    });
    observer.progress({
      callId: "search-1",
      summary: "search complete",
      title: "Web Search",
      toolName: "web_search_call",
      type: "tool_output",
    });
    const output =
      "[Official release](https://example.com/release)\n\n## Sources\n- https://example.com/release";
    const validation = observer.output(output);
    observer.close();
    observer.close();

    expect(validation).toMatchObject({
      details: {
        evidenceCount: 1,
        passed: true,
      },
      diagnostics: [],
      passed: true,
    });
    expect(flow.snapshot().events.map((event) => event.atom.key)).toEqual(
      expect.arrayContaining([
        "research.plan",
        "research.query",
        "research.search",
        "research.evidence-record",
        "research.corroborate",
        "research.synthesize",
        "research.citation-validate",
        "research.report",
      ]),
    );

    const evidenceEvents = () =>
      flow.snapshot().events.filter((event) => event.atom.key === "research.evidence-record");
    const count = evidenceEvents().length;
    ledger.record({
      claims: ["Later"],
      sourceType: "secondary",
      title: "Later",
      url: "https://example.com/later",
      verification: "unverified",
    });
    expect(evidenceEvents()).toHaveLength(count);
  });

  it("returns validation even when the domain Flow can no longer be written", async () => {
    const flow = new AtomicFlowRun({ runId: "research-degraded" });
    const ledger = new EvidenceLedger();
    const observer = new ResearchRunObserver({
      context: context(flow),
      ledger,
    });
    observer.start();
    await flow.close();

    expect(observer.output("Unsupported draft")).toMatchObject({
      details: {
        passed: false,
      },
      diagnostics: expect.arrayContaining(["Research report has no recorded evidence."]),
      passed: false,
    });
  });

  it("fails open Search spans on stop and error", () => {
    const stoppedFlow = new AtomicFlowRun({ runId: "research-stopped" });
    const stopped = new ResearchRunObserver({
      context: context(stoppedFlow),
      ledger: new EvidenceLedger(),
    });
    stopped.start();
    stopped.progress({
      callId: "search-stop",
      summary: "search",
      title: "Web Search",
      toolName: "web_search",
      type: "tool_called",
    });
    stopped.stop("cancelled");

    expect(
      stoppedFlow
        .snapshot()
        .events.find((event) => event.atom.key === "research.search" && event.phase === "error")
        ?.payload,
    ).toMatchObject({
      code: "RESEARCH_SEARCH_FAILED",
      summary: "Research stopped: cancelled",
    });
  });

  it("records one bounded degradation while preserving later validation", () => {
    const flow = new AtomicFlowRun({ runId: "research-evidence-degraded" });
    const ledger = new EvidenceLedger();
    const observer = new ResearchRunObserver({
      context: context(flow),
      ledger,
    });
    observer.start();
    observer.start();
    observer.progress({ type: "reasoning" });
    vi.spyOn(flow, "start").mockImplementationOnce(() => {
      throw new Error(`evidence ${"x".repeat(400)}`);
    });

    ledger.record({
      claims: ["Claim"],
      sourceType: "primary",
      title: "Source",
      url: "https://example.com/source",
      verification: "single-source",
    });
    ledger.record({
      claims: ["Second"],
      sourceType: "secondary",
      title: "Second",
      url: "https://example.com/second",
      verification: "unverified",
    });

    const degraded = flow
      .snapshot()
      .events.filter((event) => event.atom.key === "observability.degraded");
    expect(degraded).toHaveLength(1);
    expect(degraded[0]?.payload?.summary).toHaveLength(240);
    expect(degraded[0]?.payload?.values).toMatchObject({
      operation: "evidence",
    });
    expect(observer.output(null)).toMatchObject({
      passed: false,
    });
  });

  it("closes open spans through the error lifecycle", () => {
    const flow = new AtomicFlowRun({ runId: "research-error" });
    const observer = new ResearchRunObserver({
      context: context(flow),
      ledger: new EvidenceLedger(),
    });
    observer.progress({
      callId: "search-error",
      summary: "search",
      title: "Web Search",
      toolName: "web_search",
      type: "tool_called",
    });
    observer.error("provider failed");

    expect(
      flow
        .snapshot()
        .events.find((event) => event.atom.key === "research.search" && event.phase === "error")
        ?.payload?.summary,
    ).toBe("provider failed");
  });
});

function context(flow: AtomicFlowRun) {
  return {
    agentId: "research",
    agentKey: "research",
    agentName: "Research Agent",
    agentType: "research",
    atomicFlow: flow,
    parentInstanceId: "run",
    prompt: "Research the API.",
    runId: flow.runId,
  } as const;
}
