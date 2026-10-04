import { deepFreeze } from "./deep-freeze.js";
import { migrateSessionState } from "./session-state-migration.js";
import {
  SESSION_STATE_V5_SCHEMA_VERSION,
  type SessionStateV5,
  sessionStateV5Schema,
} from "./session-state-v5.js";

export const SESSION_STATE_SCHEMA_VERSION = SESSION_STATE_V5_SCHEMA_VERSION;
export const sessionStateSchema = sessionStateV5Schema;

export type SessionState = SessionStateV5;
export type SessionBudgetState = SessionState["budget"];
export type SessionHistoryState = SessionState["history"];
export type SessionTaskRecord = SessionState["tasks"][number];
export type SessionSubagentRecord = SessionState["subagents"][number];
export type SessionSubagentProfile = SessionState["subagentProfiles"][number];
export type SessionSubagentInstance = SessionState["subagentInstances"][number];
export type InFlightOperation = SessionState["inFlightOperations"][number];
export type CompletedOperation = NonNullable<SessionState["lastCompletedOperation"]>;
export type PendingInput = NonNullable<SessionState["pendingInput"]>;
export type ToolEffect = InFlightOperation["effect"];
export type SessionWorkingMemoryRecord = SessionState["workingMemories"][number];

export interface CreateInitialSessionStateInput {
  readonly agentKey: string;
  readonly configFingerprint: string;
  readonly modelKey: string;
  readonly now: string;
  readonly sessionId: string;
  readonly workspaceDir: string;
}

export function createInitialSessionState(input: CreateInitialSessionStateInput): SessionState {
  return parseSessionState({
    agentKey: input.agentKey,
    budget: {
      epoch: 1,
      noProgressStages: 0,
      progressRevision: 0,
      stage: 0,
      toolCalls: 0,
      totalStages: 0,
    },
    configFingerprint: input.configFingerprint,
    createdAt: input.now,
    eventLogPath: `${input.sessionId}.events.jsonl`,
    history: {
      entries: [],
    },
    inFlightOperations: [],
    modelKey: input.modelKey,
    outputStyle: "default",
    revision: 1,
    schemaVersion: SESSION_STATE_SCHEMA_VERSION,
    sessionId: input.sessionId,
    status: "active",
    subagentInstances: [],
    subagentProfiles: [],
    subagents: [],
    tasks: [],
    updatedAt: input.now,
    workingMemories: [],
    workspaceDir: input.workspaceDir,
  });
}

export function parseSessionState(value: unknown): SessionState {
  return deepFreeze(migrateSessionState(value));
}
