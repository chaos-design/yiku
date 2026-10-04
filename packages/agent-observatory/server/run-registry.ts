import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type {
  StudioRunSummary as CoreRunSummary,
  JsonValue,
  StudioEvent,
} from "@yiku/agent-studio";
import {
  FileStudioStore,
  StudioError,
  type StudioRunProjector,
  StudioRunRegistry,
} from "@yiku/agent-studio/server";
import type { AtomicFlowEvent } from "@yiku/atomic-flow";
import { YikuPaths } from "@yiku/config";
import {
  deriveAgentSessions,
  deriveAtomicRunOutput,
  deriveAtomicScorecard,
  functionalAtomicEventCount,
  projectAtomicRunStatus,
} from "./atomic-projection.js";
import { ingestionConflict } from "./ingestion.js";
import { compactJson, toJson } from "./json.js";
import type {
  AgentSessionSummary,
  EvalMode,
  EvalScorecard,
  IngestEventInput,
  IngestEventResult,
  StoredRunMetadata,
  StudioRunDetail,
  StudioRunSource,
  StudioRunStatus,
  StudioRunSummary,
} from "./types.js";

export interface RunRegistryOptions {
  readonly homeDir?: string | undefined;
  readonly runsDir?: string | undefined;
  readonly workspaceDir: string;
}

export class RunRegistry {
  private readonly registry: StudioRunRegistry;
  private readonly workspaceDir: string;

  public constructor(options: RunRegistryOptions) {
    this.workspaceDir = resolve(options.workspaceDir);
    const runsDir = resolve(
      options.runsDir ??
        new YikuPaths({
          ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
          workspaceDir: this.workspaceDir,
        }).runsDir,
    );
    const store = new FileStudioStore({
      decodeRun: (value, events) => decodeRun(value, events),
      encodeRun: (run, previous) => encodeRun(run, previous, this.workspaceDir),
      eventsFileName: "flow.jsonl",
      rootDir: runsDir,
      storageKey,
    });
    this.registry = new StudioRunRegistry({
      projectors: [atomicRunProjector()],
      store,
    });
  }

  public initialize(): Promise<void> {
    return this.registry.initialize();
  }

  public async ingest(input: IngestEventInput): Promise<IngestEventResult> {
    const current = this.registry.get(input.event.runId);
    if (current !== undefined && runSource(current) !== "external") {
      throw ingestionConflict("Run ID belongs to a Studio-managed run.", input.event.sequence);
    }

    const prompt = input.run?.prompt?.trim();
    try {
      return await this.registry.ingest(input.event, {
        createdAt: input.event.occurredAt,
        metadata: compactJson({
          agentKey: input.run?.agentKey?.trim(),
          agentName: input.run?.agentName?.trim(),
          agentType: input.run?.agentType?.trim(),
          evalMode: "blocking",
          kind: input.run?.kind ?? "agent",
          projectId: input.project?.id?.trim(),
          projectName: input.project?.name?.trim(),
          prompt,
          sessionId: input.run?.sessionId?.trim(),
          source: "external",
          workspaceDir: this.workspaceDir,
        }),
        runId: input.event.runId,
        status: projectAtomicRunStatus(input.event),
        title: prompt || `External run ${shortRunId(input.event.runId)}`,
      });
    } catch (error) {
      if (error instanceof StudioError && error.status === 409) {
        throw ingestionConflict(
          error.message.replace(/^Studio event/u, "Atomic event"),
          expectedSequence(error, input.event.sequence),
        );
      }
      throw error;
    }
  }

  public async list(): Promise<readonly StudioRunSummary[]> {
    return this.registry.list().map(toSummary);
  }

  public async get(runId: string): Promise<StudioRunDetail | undefined> {
    const detail = this.registry.get(runId);
    if (detail === undefined) {
      return undefined;
    }
    const metadata = detail.metadata ?? {};
    return {
      ...toSummary(detail),
      ...(stringValue(metadata.error) !== undefined ? { error: stringValue(metadata.error) } : {}),
      events: detail.events as readonly AtomicFlowEvent[],
      ...(stringValue(metadata.output) !== undefined
        ? { output: stringValue(metadata.output) }
        : {}),
      ...(scorecardValue(metadata.scorecard) !== undefined
        ? { scorecard: scorecardValue(metadata.scorecard) }
        : {}),
    };
  }

  public async events(runId: string, afterSequence = 0): Promise<readonly AtomicFlowEvent[]> {
    return this.registry.events(runId, afterSequence) as readonly AtomicFlowEvent[];
  }

  public subscribe(
    runId: string,
    listener: (event: AtomicFlowEvent) => void,
  ): (() => void) | undefined {
    const detail = this.registry.get(runId);
    if (detail === undefined || runSource(detail) !== "external") {
      return undefined;
    }
    return this.registry.subscribe(runId, (event) => listener(event as AtomicFlowEvent));
  }

  public async memoryEvents(runId: string): Promise<readonly AtomicFlowEvent[]> {
    return (await this.events(runId)).filter((event) => event.atom.kind === "memory");
  }

  public close(): Promise<void> {
    return this.registry.close();
  }

  public studioRegistry(): StudioRunRegistry {
    return this.registry;
  }
}

function atomicRunProjector(): StudioRunProjector {
  return {
    id: "atomic-flow-run",
    project: ({ current, event, events }) => {
      const atomicEvent = event as AtomicFlowEvent;
      const atomicEvents = events as readonly AtomicFlowEvent[];
      const agentSessions = deriveAgentSessions(atomicEvents);
      const output = deriveAtomicRunOutput(atomicEvents);
      const scorecard = deriveAtomicScorecard(atomicEvents);
      return {
        eventCount: functionalAtomicEventCount(atomicEvents),
        ...(scorecard === undefined && output === undefined && agentSessions.length === 0
          ? {}
          : {
              metadata: {
                ...current.metadata,
                ...(agentSessions.length > 0 ? { agentSessions: toJson(agentSessions) } : {}),
                ...(output !== undefined ? { output } : {}),
                ...(scorecard !== undefined ? { scorecard: toJson(scorecard) } : {}),
              },
            }),
        status: projectAtomicRunStatus(atomicEvent, current.status as StudioRunStatus),
      };
    },
  };
}

function decodeRun(value: unknown, events: readonly StudioEvent[]): CoreRunSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Stored Atomic Flow run must be an object.");
  }
  const metadata = value as StoredRunMetadata;
  if (
    typeof metadata.createdAt !== "string" ||
    typeof metadata.prompt !== "string" ||
    typeof metadata.runId !== "string" ||
    typeof metadata.status !== "string" ||
    typeof metadata.updatedAt !== "string"
  ) {
    throw new Error("Stored Atomic Flow run metadata is malformed.");
  }
  return {
    createdAt: metadata.createdAt,
    eventCount: functionalAtomicEventCount(events as readonly AtomicFlowEvent[]),
    metadata: toJson(metadata) as Readonly<Record<string, JsonValue>>,
    runId: metadata.runId,
    status: metadata.status,
    title: metadata.prompt,
    updatedAt: metadata.updatedAt,
  };
}

function encodeRun(
  run: CoreRunSummary,
  previous: unknown | undefined,
  workspaceDir: string,
): StoredRunMetadata {
  const prior =
    typeof previous === "object" && previous !== null && !Array.isArray(previous)
      ? (previous as Partial<StoredRunMetadata>)
      : {};
  const metadata = run.metadata ?? {};
  return {
    ...prior,
    ...(stringValue(metadata.agentKey) !== undefined
      ? { agentKey: stringValue(metadata.agentKey) }
      : {}),
    ...(stringValue(metadata.agentName) !== undefined
      ? { agentName: stringValue(metadata.agentName) }
      : {}),
    ...(agentSessionsValue(metadata.agentSessions) !== undefined
      ? { agentSessions: agentSessionsValue(metadata.agentSessions) }
      : {}),
    ...(stringValue(metadata.agentType) !== undefined
      ? { agentType: stringValue(metadata.agentType) }
      : {}),
    createdAt: run.createdAt,
    evalMode: evalMode(metadata.evalMode),
    kind: runKind(metadata.kind),
    ...(stringValue(metadata.error) !== undefined ? { error: stringValue(metadata.error) } : {}),
    ...(stringValue(metadata.output) !== undefined ? { output: stringValue(metadata.output) } : {}),
    ...(stringValue(metadata.projectId) !== undefined
      ? { projectId: stringValue(metadata.projectId) }
      : {}),
    ...(stringValue(metadata.projectName) !== undefined
      ? { projectName: stringValue(metadata.projectName) }
      : {}),
    prompt: run.title,
    runId: run.runId,
    ...(scorecardValue(metadata.scorecard) !== undefined
      ? { scorecard: scorecardValue(metadata.scorecard) }
      : {}),
    ...(stringValue(metadata.sessionId) !== undefined
      ? { sessionId: stringValue(metadata.sessionId) }
      : {}),
    source: sourceValue(metadata.source),
    status: run.status as StudioRunStatus,
    updatedAt: run.updatedAt,
    workspaceDir: stringValue(metadata.workspaceDir) ?? workspaceDir,
  };
}

function toSummary(run: CoreRunSummary): StudioRunSummary {
  const metadata = run.metadata ?? {};
  return {
    ...(stringValue(metadata.agentKey) !== undefined
      ? { agentKey: stringValue(metadata.agentKey) }
      : {}),
    ...(stringValue(metadata.agentName) !== undefined
      ? { agentName: stringValue(metadata.agentName) }
      : {}),
    ...(agentSessionsValue(metadata.agentSessions) !== undefined
      ? { agentSessions: agentSessionsValue(metadata.agentSessions) }
      : {}),
    ...(stringValue(metadata.agentType) !== undefined
      ? { agentType: stringValue(metadata.agentType) }
      : {}),
    createdAt: run.createdAt,
    evalMode: evalMode(metadata.evalMode),
    eventCount: run.eventCount,
    kind: runKind(metadata.kind),
    ...(stringValue(metadata.projectName) !== undefined
      ? { projectName: stringValue(metadata.projectName) }
      : {}),
    prompt: run.title,
    runId: run.runId,
    ...(stringValue(metadata.sessionId) !== undefined
      ? { sessionId: stringValue(metadata.sessionId) }
      : {}),
    source: sourceValue(metadata.source),
    status: run.status as StudioRunStatus,
    updatedAt: run.updatedAt,
  };
}

function runSource(run: CoreRunSummary): StudioRunSource {
  return sourceValue(run.metadata?.source);
}

function sourceValue(value: JsonValue | undefined): StudioRunSource {
  return value === "external" ? "external" : "studio";
}

function evalMode(value: JsonValue | undefined): EvalMode {
  return value === "async" ? "async" : "blocking";
}

function runKind(value: JsonValue | undefined): "agent" | "control" {
  return value === "control" ? "control" : "agent";
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function scorecardValue(value: JsonValue | undefined): EvalScorecard | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as {
    readonly averageScore?: JsonValue;
    readonly passed?: JsonValue;
    readonly results?: JsonValue;
  };
  return typeof candidate.averageScore === "number" &&
    typeof candidate.passed === "boolean" &&
    Array.isArray(candidate.results)
    ? (value as unknown as EvalScorecard)
    : undefined;
}

function agentSessionsValue(
  value: JsonValue | undefined,
): readonly AgentSessionSummary[] | undefined {
  return Array.isArray(value) && value.length > 0
    ? (value as unknown as readonly AgentSessionSummary[])
    : undefined;
}

function storageKey(runId: string): string {
  return /^[a-f0-9-]{36}$/u.test(runId)
    ? runId
    : `external-${createHash("sha256").update(runId).digest("hex")}`;
}

function expectedSequence(error: StudioError, fallback: number): number {
  if (isJsonObject(error.details) && typeof error.details.expectedSequence === "number") {
    return error.details.expectedSequence;
  }
  return fallback;
}

function isJsonObject(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shortRunId(runId: string): string {
  return runId.length <= 12 ? runId : `${runId.slice(0, 12)}...`;
}
