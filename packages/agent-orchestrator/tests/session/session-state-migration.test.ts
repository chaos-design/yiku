import { describe, expect, it } from "vitest";
import {
  createInitialSessionState,
  SESSION_STATE_SCHEMA_VERSION,
} from "../../src/session/session-state.js";
import { migrateSessionState } from "../../src/session/session-state-migration.js";

describe("Session State migration", () => {
  it("creates v5 state with event log and output defaults", () => {
    const state = initial();

    expect(SESSION_STATE_SCHEMA_VERSION).toBe(5);
    expect(state).toMatchObject({
      eventLogPath: "session-1.events.jsonl",
      outputStyle: "default",
      schemaVersion: 5,
      subagentInstances: [],
      subagentProfiles: [],
    });
  });

  it("migrates valid v4 state while preserving pending input", () => {
    const current = initial();
    const migrated = migrateSessionState({
      ...current,
      pendingInput: {
        kind: "permission",
        message: "Approval required.",
      },
      schemaVersion: 4,
    });

    expect(migrated).toMatchObject({
      pendingInput: {
        kind: "permission",
        message: "Approval required.",
      },
      schemaVersion: 5,
    });
  });

  it("migrates valid v3 state with conservative v4 defaults", () => {
    const current = initial();
    const {
      checkpointHead: _checkpointHead,
      eventLogPath: _eventLogPath,
      outputStyle: _outputStyle,
      title: _title,
      ...rest
    } = current;
    const migrated = migrateSessionState({
      ...rest,
      schemaVersion: 3,
    });

    expect(migrated).toMatchObject({
      checkpointHead: undefined,
      eventLogPath: "session-1.events.jsonl",
      outputStyle: "default",
      revision: current.revision,
      schemaVersion: 5,
      sessionId: current.sessionId,
    });
  });

  it("migrates valid v1 state through v3 to v4", () => {
    const {
      subagentInstances: _subagentInstances,
      subagentProfiles: _subagentProfiles,
      ...rest
    } = v3State();
    const migrated = migrateSessionState({
      ...rest,
      schemaVersion: 1,
    });

    expect(migrated).toMatchObject({
      eventLogPath: "session-1.events.jsonl",
      outputStyle: "default",
      schemaVersion: 5,
      subagentInstances: [],
      subagentProfiles: [],
    });
  });

  it("migrates valid v2 Subagent profiles through v3 to v4", () => {
    const migrated = migrateSessionState({
      ...v3State(),
      schemaVersion: 2,
      subagentProfiles: [
        {
          accessMode: "read-only",
          agentType: "code",
          createdAt: "2026-08-08T00:00:00.000Z",
          createdBy: "user",
          deliverable: "A focused code review.",
          id: "profile-1",
          instructions: "Review authentication behavior.",
          modelKey: "code",
          name: "Security Reviewer",
          role: "Review security-sensitive changes.",
          skillSnapshots: [
            {
              agentTypes: ["code"],
              description: "Review code.",
              digest: "a".repeat(64),
              instructions: "Review.",
              mcpTargets: [],
              name: "review",
              path: "/workspace/review/SKILL.md",
              resolvedAt: "2026-08-08T00:00:00.000Z",
              source: "builtin",
              version: "1.0.0",
            },
          ],
        },
      ],
    });

    expect(migrated).toMatchObject({
      eventLogPath: "session-1.events.jsonl",
      outputStyle: "default",
      schemaVersion: 5,
      subagentProfiles: [
        expect.objectContaining({
          description: "Review security-sensitive changes.",
          id: "profile-1",
          invocationMode: "manual",
          purpose: "custom",
          scopes: ["workspace"],
          source: "session",
        }),
      ],
    });
  });

  it("rejects unknown future schema versions", () => {
    expect(() => migrateSessionState({ ...initial(), schemaVersion: 6 })).toThrow(
      "Unsupported Session State schema version",
    );
  });
});

function initial() {
  return createInitialSessionState({
    agentKey: "code",
    configFingerprint: "fingerprint",
    modelKey: "code",
    now: "2026-08-08T00:00:00.000Z",
    sessionId: "session-1",
    workspaceDir: "/workspace",
  });
}

function v3State() {
  const {
    checkpointHead: _checkpointHead,
    eventLogPath: _eventLogPath,
    outputStyle: _outputStyle,
    title: _title,
    ...rest
  } = initial();
  return {
    ...rest,
    schemaVersion: 3,
  };
}
