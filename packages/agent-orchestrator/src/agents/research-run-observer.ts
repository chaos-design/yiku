import { randomUUID } from "node:crypto";
import {
  type EvidenceLedger,
  ResearchFlowTracker,
  type ResearchReportValidation,
  validateResearchReport,
} from "@yiku/agent-research";
import { RUNTIME_ATOMS } from "../runtime/atoms.js";
import type { AgentProgressEvent, AgentRunValidation, AgentStopReason } from "../runtime/types.js";
import { boundedSummary } from "./bounded-summary.js";
import type { AgentObservabilityContext, AgentRunObserver } from "./types.js";

export interface ResearchRunObserverOptions {
  readonly context: AgentObservabilityContext;
  readonly ledger: EvidenceLedger;
}

export class ResearchRunObserver implements AgentRunObserver {
  private closed = false;
  private degraded = false;
  private readonly flow: ResearchFlowTracker;
  private started = false;
  private readonly unsubscribeEvidence: () => void;

  public constructor(private readonly options: ResearchRunObserverOptions) {
    this.flow = new ResearchFlowTracker(options.context.atomicFlow);
    this.unsubscribeEvidence = options.ledger.subscribe((evidence) => {
      try {
        this.flow.recordEvidence(evidence);
      } catch (error) {
        this.reportDegraded("evidence", error);
      }
    });
  }

  public start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.flow.begin(this.options.context.prompt);
  }

  public progress(event: AgentProgressEvent): void {
    this.start();
    switch (event.type) {
      case "tool_called":
        this.flow.toolCalled(event);
        return;
      case "tool_output":
        this.flow.toolOutput(event);
        return;
      default:
        return;
    }
  }

  public output(output: unknown): AgentRunValidation {
    this.start();
    const text = typeof output === "string" ? output : String(output ?? "");
    const validation = validateResearchReport(text, this.options.ledger);
    try {
      this.flow.finishReport(text, validation);
    } catch (error) {
      this.reportDegraded("output", error);
    }
    return toRunValidation(validation);
  }

  public stop(reason: AgentStopReason): void {
    this.flow.fail(new Error(`Research stopped: ${reason}`));
  }

  public error(cause: unknown): void {
    this.flow.fail(cause);
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.unsubscribeEvidence();
  }

  private reportDegraded(operation: string, cause: unknown): void {
    if (this.degraded) {
      return;
    }
    this.degraded = true;
    try {
      this.options.context.atomicFlow.emit({
        atom: RUNTIME_ATOMS.observabilityDegraded,
        instance: {
          id: randomUUID(),
          parentId: this.options.context.parentInstanceId,
        },
        internal: true,
        payload: {
          code: "RESEARCH_OBSERVER_FAILED",
          summary: boundedSummary(cause instanceof Error ? cause.message : String(cause)),
          values: {
            agentId: this.options.context.agentId,
            agentType: this.options.context.agentType,
            operation,
          },
        },
        phase: "error",
      });
    } catch {
      // A failed diagnostic cannot alter Research validation.
    }
  }
}

function toRunValidation(validation: ResearchReportValidation): AgentRunValidation {
  return {
    details: validation,
    diagnostics: validation.diagnostics,
    passed: validation.passed,
  };
}
