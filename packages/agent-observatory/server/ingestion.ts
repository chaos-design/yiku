import type { AtomicEdgeKind, AtomicKind, AtomicLevel, AtomicPhase } from "@yiku/atomic-flow";
import type { IngestEventInput } from "./types.js";

const EDGE_KINDS = new Set<AtomicEdgeKind>(["data", "execution", "feedback", "persistence"]);
const KINDS = new Set<AtomicKind>([
  "action",
  "agent",
  "context",
  "eval",
  "handoff",
  "hook",
  "input",
  "loop",
  "memory",
  "model",
  "release",
  "reply",
  "skill",
  "store",
  "tool",
  "trace",
  "trajectory",
  "usage",
]);
const LEVELS = new Set<AtomicLevel>(["deep", "runtime"]);
const PHASES = new Set<AtomicPhase>(["delta", "end", "error", "scheduled", "skipped", "start"]);

export class IngestionError extends Error {
  public constructor(
    public readonly code: "INGESTION_CONFLICT" | "INGESTION_INVALID",
    message: string,
    public readonly status: 400 | 409,
    public readonly expectedSequence?: number | undefined,
  ) {
    super(message);
    this.name = "IngestionError";
  }
}

export function parseIngestEvent(value: unknown): IngestEventInput {
  const body = requireRecord(value, "Ingestion body");
  const event = requireRecord(body.event, "Atomic event");
  const atom = requireRecord(event.atom, "Atomic atom");
  const instance = requireRecord(event.instance, "Atomic instance");

  requireText(event.runId, "Run ID", 128);
  requireText(event.eventId, "Event ID", 256);
  requirePositiveInteger(event.sequence, "Event sequence");
  requireTimestamp(event.occurredAt);
  requireMember(event.phase, PHASES, "Atomic phase");
  requireText(atom.key, "Atom key", 128);
  requireText(atom.label, "Atom label", 128);
  requireMember(atom.kind, KINDS, "Atom kind");
  requireMember(atom.level, LEVELS, "Atom level");
  requireText(instance.id, "Instance ID", 256);
  requireOptionalText(instance.parentId, "Parent instance ID", 256);
  if (instance.iteration !== undefined) {
    requirePositiveInteger(instance.iteration, "Instance iteration");
  }
  if (event.internal !== undefined && typeof event.internal !== "boolean") {
    invalid("Atomic internal flag must be a boolean.");
  }
  if (event.payload !== undefined) {
    requireRecord(event.payload, "Atomic payload");
  }
  if (event.edge !== undefined) {
    const edge = requireRecord(event.edge, "Atomic edge");
    requireText(edge.fromAtomKey, "Edge source", 128);
    requireText(edge.toAtomKey, "Edge target", 128);
    requireOptionalText(edge.fromInstanceId, "Edge source instance", 256);
    requireMember(edge.kind, EDGE_KINDS, "Edge kind");
    if (edge.toAtomKey !== atom.key) {
      invalid("Atomic edge target must match the event atom.");
    }
  }

  if (body.project !== undefined) {
    const project = requireRecord(body.project, "Project metadata");
    requireOptionalText(project.id, "Project ID", 128);
    requireOptionalText(project.name, "Project name", 128);
  }
  if (body.run !== undefined) {
    const run = requireRecord(body.run, "Run metadata");
    requireOptionalText(run.agentKey, "Agent key", 128);
    requireOptionalText(run.agentName, "Agent name", 128);
    requireOptionalText(run.agentType, "Agent type", 128);
    if (run.kind !== undefined && run.kind !== "agent" && run.kind !== "control") {
      invalid("Run kind must be agent or control.");
    }
    requireOptionalText(run.prompt, "Run prompt", 4_096);
    requireOptionalText(run.sessionId, "Session ID", 128);
  }

  return value as IngestEventInput;
}

export function ingestionConflict(message: string, expectedSequence: number): IngestionError {
  return new IngestionError("INGESTION_CONFLICT", message, 409, expectedSequence);
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireText(value: unknown, name: string, maxLength: number): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    invalid(`${name} must be non-empty.`);
  }
  if (value.length > maxLength) {
    invalid(`${name} exceeds ${maxLength} characters.`);
  }
}

function requireOptionalText(value: unknown, name: string, maxLength: number): void {
  if (value !== undefined) {
    requireText(value, name, maxLength);
  }
}

function requirePositiveInteger(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    invalid(`${name} must be a positive integer.`);
  }
}

function requireTimestamp(value: unknown): void {
  requireText(value, "Event timestamp", 64);
  try {
    if (new Date(value).toISOString() !== value) {
      invalid("Event timestamp must be an ISO timestamp.");
    }
  } catch {
    invalid("Event timestamp must be an ISO timestamp.");
  }
}

function requireMember<T extends string>(
  value: unknown,
  values: ReadonlySet<T>,
  name: string,
): asserts value is T {
  if (typeof value !== "string" || !values.has(value as T)) {
    invalid(`${name} is not supported.`);
  }
}

function invalid(message: string): never {
  throw new IngestionError("INGESTION_INVALID", message, 400);
}
