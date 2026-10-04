import type { IncomingMessage } from "node:http";
import type {
  JsonValue,
  StudioEvent,
  StudioPluginManifest,
  StudioRunSeed,
  StudioRunSummary,
  StudioStatusDefinition,
} from "../types.js";
import type { StudioRunRegistry } from "./run-registry.js";

export interface StoredStudioRun {
  readonly events: readonly StudioEvent[];
  readonly run: StudioRunSummary;
}

export interface StudioStore {
  appendEvent(event: StudioEvent): Promise<void>;
  close(): Promise<void>;
  initialize(): Promise<readonly StoredStudioRun[]>;
  writeRun(run: StudioRunSummary): Promise<void>;
}

export interface StudioRunProjectionContext {
  readonly current: StudioRunSummary;
  readonly event: StudioEvent;
  readonly events: readonly StudioEvent[];
}

export interface StudioRunProjector {
  readonly id: string;
  project(
    context: StudioRunProjectionContext,
  ): Promise<Partial<StudioRunSummary>> | Partial<StudioRunSummary>;
}

export interface StudioEventAdapterResult {
  readonly event: StudioEvent;
  readonly seed: StudioRunSeed;
}

export interface StudioEventAdapter {
  readonly id: string;
  parse(input: unknown): Promise<StudioEventAdapterResult> | StudioEventAdapterResult;
}

export interface StudioRouteRequest {
  readonly body: () => Promise<unknown>;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly registry: StudioRunRegistry;
  readonly request: IncomingMessage;
  readonly url: URL;
}

export interface StudioRouteResponse {
  readonly body?: JsonValue | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly status?: number | undefined;
}

export interface StudioRoute {
  readonly handle:
    | ((request: StudioRouteRequest) => Promise<StudioRouteResponse>)
    | ((request: StudioRouteRequest) => StudioRouteResponse);
  readonly id: string;
  readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  readonly path: `/${string}`;
}

export interface StudioServerPluginContext {
  readonly registry: StudioRunRegistry;
}

export interface StudioServerPlugin {
  readonly adapters?: readonly StudioEventAdapter[] | undefined;
  dispose?(context: StudioServerPluginContext): Promise<void> | void;
  initialize?(context: StudioServerPluginContext): Promise<void> | void;
  readonly manifest: StudioPluginManifest;
  readonly projectors?: readonly StudioRunProjector[] | undefined;
  readonly routes?: readonly StudioRoute[] | undefined;
  readonly statuses?: readonly StudioStatusDefinition[] | undefined;
  readonly store?: StudioStore | undefined;
}

export interface StudioIngestResult {
  readonly duplicate: boolean;
  readonly expectedSequence: number;
  readonly runId: string;
}
