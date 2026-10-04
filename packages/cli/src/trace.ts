import type { AgentProgressEvent } from "@yiku/agent-orchestrator";
import { Trace as BaseTrace, type TraceEntry as BaseTraceEntry } from "@yiku/trajectory";

export type TraceEntry = BaseTraceEntry<AgentProgressEvent>;

export class Trace extends BaseTrace<AgentProgressEvent> {}
