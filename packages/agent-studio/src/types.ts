export type JsonPrimitive = boolean | null | number | string;

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface StudioEvent {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly runId: string;
  readonly sequence: number;
}

export type StudioRunLifecycle = "active" | "pending" | "terminal";

export interface StudioStatusDefinition {
  readonly key: string;
  readonly label: string;
  readonly lifecycle: StudioRunLifecycle;
  readonly tone?: "danger" | "info" | "neutral" | "success" | "warning" | undefined;
}

export interface StudioRunSummary {
  readonly createdAt: string;
  readonly eventCount: number;
  readonly extensions?: Readonly<Record<string, JsonValue>> | undefined;
  readonly metadata?: Readonly<Record<string, JsonValue>> | undefined;
  readonly runId: string;
  readonly status: string;
  readonly title: string;
  readonly updatedAt: string;
}

export interface StudioRunDetail extends StudioRunSummary {
  readonly events: readonly StudioEvent[];
}

export interface StudioRunSeed {
  readonly createdAt: string;
  readonly extensions?: Readonly<Record<string, JsonValue>> | undefined;
  readonly metadata?: Readonly<Record<string, JsonValue>> | undefined;
  readonly runId: string;
  readonly status: string;
  readonly title: string;
  readonly updatedAt?: string | undefined;
}

export interface StudioPluginManifest {
  readonly capabilities: readonly string[];
  readonly id: string;
  readonly name: string;
  readonly requires?: readonly string[] | undefined;
  readonly studioVersion: string;
  readonly version: string;
}
