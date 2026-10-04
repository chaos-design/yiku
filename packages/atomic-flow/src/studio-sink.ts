import { AtomicFlowError } from "./errors.js";
import type {
  AtomicFlowEvent,
  AtomicFlowSink,
  AtomicStudioProject,
  AtomicStudioRunMetadata,
  AtomicStudioSinkOptions,
} from "./types.js";

const INGESTION_PATH = "/api/ingest/events";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

export class AtomicStudioSink implements AtomicFlowSink {
  public readonly id = "studio";
  private readonly endpoint: string;
  private readonly project: AtomicStudioProject | undefined;
  private readonly request: typeof fetch;
  private readonly run: AtomicStudioRunMetadata | undefined;
  private runMetadataPending: boolean;

  public constructor(options: AtomicStudioSinkOptions) {
    this.endpoint = resolveEndpoint(options.endpoint);
    this.project = normalizeProject(options.project);
    this.request = options.request ?? fetch;
    this.run = normalizeRun(options.run);
    this.runMetadataPending = this.run !== undefined;
  }

  public async write(event: AtomicFlowEvent): Promise<undefined> {
    try {
      const response = await this.request(this.endpoint, {
        body: JSON.stringify({
          event,
          ...(this.project !== undefined ? { project: this.project } : {}),
          ...(this.runMetadataPending && this.run !== undefined ? { run: this.run } : {}),
        }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });

      if (!response.ok) {
        throw new AtomicFlowError("ATOMIC_FLOW_SINK_FAILED", await responseMessage(response));
      }
      this.runMetadataPending = false;
      return undefined;
    } catch (error) {
      if (error instanceof AtomicFlowError) {
        throw error;
      }
      throw new AtomicFlowError("ATOMIC_FLOW_SINK_FAILED", "Atomic Studio event delivery failed.", {
        cause: error,
      });
    }
  }
}

function resolveEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value.trim());
  } catch (error) {
    throw new AtomicFlowError(
      "ATOMIC_FLOW_INVALID_RUN",
      "Atomic Studio URL must be a valid loopback HTTP URL.",
      { cause: error },
    );
  }

  if (endpoint.protocol !== "http:" || !LOOPBACK_HOSTS.has(endpoint.hostname.toLowerCase())) {
    throw new AtomicFlowError(
      "ATOMIC_FLOW_INVALID_RUN",
      "Atomic Studio URL must be a loopback HTTP URL.",
    );
  }
  if (endpoint.username || endpoint.password) {
    throw new AtomicFlowError(
      "ATOMIC_FLOW_INVALID_RUN",
      "Atomic Studio URL must not include credentials.",
    );
  }

  const path = endpoint.pathname.replace(/\/+$/u, "");
  endpoint.pathname = path.endsWith(INGESTION_PATH) ? path : `${path}${INGESTION_PATH}`;
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint.toString();
}

function normalizeProject(
  project: AtomicStudioProject | undefined,
): AtomicStudioProject | undefined {
  if (project === undefined) {
    return undefined;
  }
  const id = normalizeProjectField(project.id);
  const name = normalizeProjectField(project.name);
  return id === undefined && name === undefined
    ? undefined
    : {
        ...(id !== undefined ? { id } : {}),
        ...(name !== undefined ? { name } : {}),
      };
}

function normalizeProjectField(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 128) : undefined;
}

function normalizeRun(
  run: AtomicStudioRunMetadata | undefined,
): AtomicStudioRunMetadata | undefined {
  if (run === undefined) {
    return undefined;
  }
  const agentKey = normalizeRunField(run.agentKey, 128);
  const agentName = normalizeRunField(run.agentName, 128);
  const agentType = normalizeRunField(run.agentType, 128);
  const kind = run.kind;
  const prompt = normalizeRunField(run.prompt, 4_096);
  const sessionId = normalizeRunField(run.sessionId, 128);
  return agentKey === undefined &&
    agentName === undefined &&
    agentType === undefined &&
    kind === undefined &&
    prompt === undefined &&
    sessionId === undefined
    ? undefined
    : {
        ...(agentKey !== undefined ? { agentKey } : {}),
        ...(agentName !== undefined ? { agentName } : {}),
        ...(agentType !== undefined ? { agentType } : {}),
        ...(kind !== undefined ? { kind } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
      };
}

function normalizeRunField(value: string | undefined, maxLength: number): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

async function responseMessage(response: Response): Promise<string> {
  try {
    const value = (await response.json()) as { readonly message?: unknown };
    if (typeof value.message === "string" && value.message.trim()) {
      return value.message;
    }
  } catch {
    // Fall through to the stable status message.
  }
  return `Atomic Studio rejected event with status ${response.status}.`;
}
