import type { AtomicFlowRun, AtomicSpan } from "@yiku/atomic-flow";
import type { ResearchEvidence, ResearchReportValidation } from "../evidence/types.js";
import { RESEARCH_ATOMS } from "./atoms.js";

const SUMMARY_LIMIT = 240;

export interface ResearchToolEvent {
  readonly callId?: string | undefined;
  readonly summary?: string | undefined;
  readonly toolName: string;
}

export class ResearchFlowTracker {
  private begun = false;
  private corroborationInstanceId: string | undefined;
  private evidenceCount = 0;
  private latestEvidenceInstanceId: string | undefined;
  private latestSearchInstanceId: string | undefined;
  private planInstanceId: string | undefined;
  private queryCount = 0;
  private readonly searchOrder: string[] = [];
  private readonly searchSpans = new Map<string, AtomicSpan>();
  private synthesisSpan: AtomicSpan | undefined;

  public constructor(private readonly flow: AtomicFlowRun) {}

  public begin(brief: string): void {
    if (this.begun) {
      return;
    }
    this.begun = true;
    this.planInstanceId = this.complete(RESEARCH_ATOMS.plan, undefined, undefined, bounded(brief), {
      queries: 0,
    });
  }

  public toolCalled(event: ResearchToolEvent): void {
    if (!isWebSearch(event.toolName)) {
      return;
    }
    this.ensureBegun();
    this.queryCount += 1;
    const queryInstanceId = this.complete(
      RESEARCH_ATOMS.query,
      RESEARCH_ATOMS.plan.key,
      this.planInstanceId,
      bounded(event.summary ?? `Query ${this.queryCount}`),
      {
        query: this.queryCount,
      },
    );
    const callKey = event.callId ?? `search-${this.queryCount}`;
    const searchSpan = this.flow.start({
      atom: RESEARCH_ATOMS.search,
      edge: {
        fromAtomKey: RESEARCH_ATOMS.query.key,
        fromInstanceId: queryInstanceId,
        kind: "execution",
        toAtomKey: RESEARCH_ATOMS.search.key,
      },
      instanceId: `research-search-${callKey}`,
      parentInstanceId: queryInstanceId,
      payload: {
        summary: bounded(event.summary ?? event.toolName),
        values: {
          callId: callKey,
          query: this.queryCount,
        },
      },
    });
    this.searchOrder.push(callKey);
    this.searchSpans.set(callKey, searchSpan);
  }

  public toolOutput(event: ResearchToolEvent): void {
    if (!isWebSearch(event.toolName)) {
      return;
    }
    const callKey = event.callId ?? this.searchOrder[0];
    if (callKey === undefined) {
      return;
    }
    const span = this.searchSpans.get(callKey);
    if (span === undefined) {
      return;
    }
    this.latestSearchInstanceId = span.instanceId;
    this.searchSpans.delete(callKey);
    const orderIndex = this.searchOrder.indexOf(callKey);
    if (orderIndex >= 0) {
      this.searchOrder.splice(orderIndex, 1);
    }
    span.end({
      summary: bounded(event.summary ?? "Search completed"),
    });
  }

  public recordEvidence(evidence: ResearchEvidence): void {
    this.ensureBegun();
    this.evidenceCount += 1;
    const latestSearch = [...this.searchSpans.values()].at(-1);
    const parentInstanceId =
      latestSearch?.instanceId ?? this.latestSearchInstanceId ?? this.planInstanceId;
    const fromAtomKey =
      latestSearch === undefined && this.latestSearchInstanceId === undefined
        ? RESEARCH_ATOMS.plan.key
        : RESEARCH_ATOMS.search.key;
    this.latestEvidenceInstanceId = this.complete(
      RESEARCH_ATOMS.evidenceRecord,
      fromAtomKey,
      parentInstanceId,
      bounded(evidence.title),
      {
        claims: evidence.claims.length,
        evidence: this.evidenceCount,
      },
      {
        evidenceId: evidence.id,
        sourceType: evidence.sourceType,
        verification: evidence.verification,
      },
    );

    if (evidence.verification === "corroborated") {
      this.completeCorroboration("Evidence marked as corroborated");
    }
  }

  public beginSynthesis(): void {
    if (this.synthesisSpan !== undefined) {
      return;
    }
    this.ensureBegun();
    this.finishOpenSearches("Search stream completed");
    this.completeCorroboration(
      this.evidenceCount > 1
        ? `${this.evidenceCount} evidence records reviewed`
        : "Evidence limitations reviewed",
    );
    const parentInstanceId =
      this.corroborationInstanceId ?? this.latestEvidenceInstanceId ?? this.planInstanceId;
    const fromAtomKey =
      this.corroborationInstanceId !== undefined
        ? RESEARCH_ATOMS.corroborate.key
        : this.latestEvidenceInstanceId !== undefined
          ? RESEARCH_ATOMS.evidenceRecord.key
          : RESEARCH_ATOMS.plan.key;
    this.synthesisSpan = this.flow.start({
      atom: RESEARCH_ATOMS.synthesize,
      edge: {
        fromAtomKey,
        ...(parentInstanceId !== undefined ? { fromInstanceId: parentInstanceId } : {}),
        kind: "execution",
        toAtomKey: RESEARCH_ATOMS.synthesize.key,
      },
      instanceId: `research-synthesize-${this.flow.runId}`,
      ...(parentInstanceId !== undefined ? { parentInstanceId } : {}),
      payload: {
        counts: {
          evidence: this.evidenceCount,
          queries: this.queryCount,
        },
      },
    });
  }

  public finishReport(output: string, validation: ResearchReportValidation): void {
    this.beginSynthesis();
    const synthesisSpan = this.synthesisSpan;
    synthesisSpan?.end({
      counts: {
        evidence: validation.evidenceCount,
      },
      summary: "Research synthesis completed",
    });
    this.synthesisSpan = undefined;

    const validationSpan = this.flow.start({
      atom: RESEARCH_ATOMS.citationValidate,
      edge: {
        fromAtomKey: RESEARCH_ATOMS.synthesize.key,
        ...(synthesisSpan !== undefined ? { fromInstanceId: synthesisSpan.instanceId } : {}),
        kind: "execution",
        toAtomKey: RESEARCH_ATOMS.citationValidate.key,
      },
      instanceId: `research-citation-validate-${this.flow.runId}`,
      ...(synthesisSpan !== undefined ? { parentInstanceId: synthesisSpan.instanceId } : {}),
    });
    const validationPayload = {
      counts: {
        diagnostics: validation.diagnostics.length,
        evidence: validation.evidenceCount,
        primarySources: validation.primarySourceCount,
      },
      summary: validation.passed ? "Citation validation passed" : "Citation validation failed",
      values: {
        passed: validation.passed,
      },
    } as const;
    if (validation.passed) {
      validationSpan.end(validationPayload);
    } else {
      validationSpan.fail({
        ...validationPayload,
        code: "RESEARCH_CITATION_VALIDATION_FAILED",
      });
    }

    const reportSpan = this.flow.start({
      atom: RESEARCH_ATOMS.report,
      edge: {
        fromAtomKey: RESEARCH_ATOMS.citationValidate.key,
        fromInstanceId: validationSpan.instanceId,
        kind: "execution",
        toAtomKey: RESEARCH_ATOMS.report.key,
      },
      instanceId: `research-report-${this.flow.runId}`,
      parentInstanceId: validationSpan.instanceId,
    });
    reportSpan.end({
      counts: {
        characters: output.length,
        evidence: validation.evidenceCount,
      },
      summary: validation.passed ? "Validated research report" : "Research report with diagnostics",
      values: {
        passed: validation.passed,
      },
    });
  }

  public fail(cause: unknown): void {
    const message = bounded(cause instanceof Error ? cause.message : String(cause));
    this.finishOpenSearches(message, true);
    if (this.synthesisSpan !== undefined) {
      this.synthesisSpan.fail({
        code: "RESEARCH_SYNTHESIS_FAILED",
        summary: message,
      });
      this.synthesisSpan = undefined;
    }
  }

  private completeCorroboration(summary: string): void {
    if (this.corroborationInstanceId !== undefined) {
      return;
    }
    const parentInstanceId = this.latestEvidenceInstanceId ?? this.planInstanceId;
    const fromAtomKey =
      this.latestEvidenceInstanceId === undefined
        ? RESEARCH_ATOMS.plan.key
        : RESEARCH_ATOMS.evidenceRecord.key;
    this.corroborationInstanceId = this.complete(
      RESEARCH_ATOMS.corroborate,
      fromAtomKey,
      parentInstanceId,
      bounded(summary),
      {
        evidence: this.evidenceCount,
      },
    );
  }

  private complete(
    atom: (typeof RESEARCH_ATOMS)[keyof typeof RESEARCH_ATOMS],
    fromAtomKey: string | undefined,
    parentInstanceId: string | undefined,
    summary: string,
    counts?: Readonly<Record<string, number>>,
    values?: Readonly<Record<string, boolean | number | string>>,
  ): string {
    const span = this.flow.start({
      atom,
      ...(fromAtomKey !== undefined
        ? {
            edge: {
              fromAtomKey,
              ...(parentInstanceId !== undefined ? { fromInstanceId: parentInstanceId } : {}),
              kind: "execution" as const,
              toAtomKey: atom.key,
            },
          }
        : {}),
      ...(parentInstanceId !== undefined ? { parentInstanceId } : {}),
      payload: {
        ...(counts !== undefined ? { counts } : {}),
        summary,
        ...(values !== undefined ? { values } : {}),
      },
    });
    span.end({
      ...(counts !== undefined ? { counts } : {}),
      summary,
      ...(values !== undefined ? { values } : {}),
    });
    return span.instanceId;
  }

  private ensureBegun(): void {
    if (!this.begun) {
      this.begin("Research brief");
    }
  }

  private finishOpenSearches(summary: string, failed = false): void {
    for (const span of this.searchSpans.values()) {
      if (failed) {
        span.fail({
          code: "RESEARCH_SEARCH_FAILED",
          summary,
        });
      } else {
        span.end({ summary });
      }
    }
    this.searchOrder.length = 0;
    this.searchSpans.clear();
  }
}

function bounded(value: string): string {
  const normalized = value.replaceAll(/\s+/gu, " ").trim();
  return normalized.length <= SUMMARY_LIMIT
    ? normalized
    : `${normalized.slice(0, SUMMARY_LIMIT - 3)}...`;
}

function isWebSearch(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase().replaceAll("-", "_");
  return (
    normalized === "web_search" || normalized === "web_search_call" || normalized === "websearch"
  );
}
