import { SESSION_STATE_V1_SCHEMA_VERSION, sessionStateV1Schema } from "./session-state-v1.js";
import { SESSION_STATE_V2_SCHEMA_VERSION, sessionStateV2Schema } from "./session-state-v2.js";
import {
  SESSION_STATE_V3_SCHEMA_VERSION,
  type SessionStateV3,
  sessionStateV3Schema,
} from "./session-state-v3.js";
import {
  SESSION_STATE_V4_SCHEMA_VERSION,
  type SessionStateV4,
  sessionStateV4Schema,
} from "./session-state-v4.js";
import {
  SESSION_STATE_V5_SCHEMA_VERSION,
  type SessionStateV5,
  sessionStateV5Schema,
} from "./session-state-v5.js";

export function migrateSessionState(value: unknown): SessionStateV5 {
  const version = isRecord(value) ? value.schemaVersion : undefined;

  if (version === SESSION_STATE_V5_SCHEMA_VERSION) {
    return sessionStateV5Schema.parse(value);
  }

  const current = migrateToV4(value);
  return sessionStateV5Schema.parse({
    ...current,
    schemaVersion: SESSION_STATE_V5_SCHEMA_VERSION,
  });
}

function migrateToV4(value: unknown): SessionStateV4 {
  const version = isRecord(value) ? value.schemaVersion : undefined;

  if (version === SESSION_STATE_V4_SCHEMA_VERSION) {
    return sessionStateV4Schema.parse(value);
  }

  const current = migrateToV3(value);
  return sessionStateV4Schema.parse({
    agentKey: current.agentKey,
    budget: current.budget,
    checkpointHead: undefined,
    configFingerprint: current.configFingerprint,
    createdAt: current.createdAt,
    eventLogPath: `${current.sessionId}.events.jsonl`,
    history: current.history,
    inFlightOperations: current.inFlightOperations,
    lastCompletedOperation: current.lastCompletedOperation,
    modelKey: current.modelKey,
    outputStyle: "default",
    pendingInput: current.pendingInput,
    revision: current.revision,
    schemaVersion: SESSION_STATE_V4_SCHEMA_VERSION,
    sessionId: current.sessionId,
    status: current.status,
    subagentInstances: current.subagentInstances,
    subagentProfiles: current.subagentProfiles,
    subagents: current.subagents,
    tasks: current.tasks,
    title: undefined,
    updatedAt: current.updatedAt,
    workingMemories: current.workingMemories,
    workspaceDir: current.workspaceDir,
  });
}

function migrateToV3(value: unknown): SessionStateV3 {
  const version = isRecord(value) ? value.schemaVersion : undefined;

  if (version === SESSION_STATE_V3_SCHEMA_VERSION) {
    return sessionStateV3Schema.parse(value);
  }
  if (version === SESSION_STATE_V1_SCHEMA_VERSION) {
    const current = sessionStateV1Schema.parse(value);
    return sessionStateV3Schema.parse({
      ...current,
      schemaVersion: SESSION_STATE_V3_SCHEMA_VERSION,
      subagentInstances: [],
      subagentProfiles: [],
    });
  }
  if (version === SESSION_STATE_V2_SCHEMA_VERSION) {
    const current = sessionStateV2Schema.parse(value);
    return sessionStateV3Schema.parse({
      ...current,
      schemaVersion: SESSION_STATE_V3_SCHEMA_VERSION,
      subagentProfiles: current.subagentProfiles.map((profile) => ({
        ...profile,
        description: profile.role,
        invocationMode: "manual",
        purpose: "custom",
        scopes: ["workspace"],
        source: "session",
      })),
    });
  }

  throw new Error(`Unsupported Session State schema version: ${String(version)}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
