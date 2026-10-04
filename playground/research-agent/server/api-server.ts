import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { AtomicFlowRun, AtomicStudioSink } from "@yiku/atomic-flow";
import {
  ConversationConflictError,
  ConversationRegistry,
  ConversationValidationError,
} from "./conversation-registry.js";
import { FileResearchConversationStore } from "./conversation-store.js";
import { RunRegistry, RunValidationError } from "./run-registry.js";
import type {
  ResearchRunExecutor,
  ResearchSkillId,
  ResearchTurnOptions,
  RunStreamEvent,
} from "./types.js";

const MAX_BODY_BYTES = 16 * 1024;

export interface ApiServerOptions {
  readonly conversationRegistry?: ConversationRegistry | undefined;
  readonly dataFilePath?: string | undefined;
  readonly host?: string | undefined;
  readonly observatoryApiUrl?: string | undefined;
  readonly observatoryWebUrl?: string | undefined;
  readonly port?: number | undefined;
  readonly request?: typeof fetch | undefined;
  readonly researchExecutor?: ResearchRunExecutor | undefined;
  readonly registry?: RunRegistry | undefined;
  readonly workspaceDir?: string | undefined;
}

export class ApiServer {
  private readonly conversationRegistry: ConversationRegistry;
  private readonly host: string;
  private readonly observatoryApiUrl: string;
  private readonly observatoryWebUrl: string;
  private readonly port: number;
  private readonly request: typeof fetch;
  private readonly registry: RunRegistry;
  private server: Server | undefined;

  public constructor(options: ApiServerOptions = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 4328;
    this.registry = options.registry ?? new RunRegistry();
    this.request = options.request ?? fetch;
    this.observatoryApiUrl = loopbackUrl(
      options.observatoryApiUrl ??
        (process.env.YIKU_ATOMIC_STUDIO_URL?.trim() || "http://127.0.0.1:4318"),
      "Observatory API URL",
    );
    this.observatoryWebUrl = loopbackUrl(
      options.observatoryWebUrl ?? "http://127.0.0.1:4317",
      "Observatory Web URL",
    );
    const workspaceDir = resolve(
      options.workspaceDir ?? process.env.INIT_CWD?.trim() ?? process.cwd(),
    );
    const dataFilePath = options.dataFilePath ?? process.env.YIKU_RESEARCHER_DATA_FILE?.trim();
    this.conversationRegistry =
      options.conversationRegistry ??
      new ConversationRegistry({
        createAtomicFlow: ({ prompt, threadId, turnId }) =>
          new AtomicFlowRun({
            runId: turnId,
            sinks: [
              new AtomicStudioSink({
                endpoint: this.observatoryApiUrl,
                project: {
                  name: basename(workspaceDir),
                },
                request: this.request,
                run: {
                  agentKey: "research",
                  agentName: "Yiku Research Agent",
                  agentType: "research",
                  kind: "agent",
                  prompt,
                  sessionId: threadId,
                },
              }),
            ],
          }),
        ...(options.researchExecutor !== undefined ? { executor: options.researchExecutor } : {}),
        store: new FileResearchConversationStore({
          filePath:
            dataFilePath || join(homedir(), ".yiku", "research-agent", "conversations.json"),
        }),
      });
  }

  public async start(): Promise<{ readonly host: string; readonly port: number }> {
    if (this.host !== "127.0.0.1" && this.host !== "localhost") {
      throw new Error("Research Agent Playground only binds to loopback.");
    }
    if (this.server !== undefined) {
      throw new Error("Research Agent Playground API is already running.");
    }
    await this.conversationRegistry.initialize();

    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, this.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;

    return {
      host: this.host,
      port: address.port,
    };
  }

  public async close(): Promise<void> {
    await Promise.all([this.registry.close(), this.conversationRegistry.close()]);
    const server = this.server;
    this.server = undefined;

    if (server !== undefined) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId = randomUUID();

    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", `http://${this.host}`);
      const segments = url.pathname.split("/").filter(Boolean);

      if (method === "GET" && url.pathname === "/api/health") {
        return json(response, 200, { status: "ok" });
      }
      if (method === "GET" && url.pathname === "/api/observatory") {
        return json(response, 200, await this.observatoryStatus());
      }
      if (segments[0] === "api" && segments[1] === "threads") {
        if (method === "GET" && segments.length === 2) {
          return json(response, 200, this.conversationRegistry.listThreads());
        }
        if (method === "POST" && segments.length === 2) {
          const input = await readJson(request);
          return json(
            response,
            201,
            await this.conversationRegistry.createThread(readOptionalTitle(input)),
          );
        }
        const threadId = segments[2];
        if (threadId === undefined) {
          throw new ApiRequestError(404, "THREAD_NOT_FOUND", "Research thread not found.");
        }
        if (method === "GET" && segments.length === 3) {
          const thread = this.conversationRegistry.getThread(threadId);
          if (thread === undefined) {
            throw new ApiRequestError(404, "THREAD_NOT_FOUND", "Research thread not found.");
          }
          return json(response, 200, thread);
        }
        if (method === "DELETE" && segments.length === 3) {
          const result = await this.conversationRegistry.deleteThread(threadId);
          if (result === "not-found") {
            throw new ApiRequestError(404, "THREAD_NOT_FOUND", "Research thread not found.");
          }
          return json(response, 200, {
            deleted: true,
            threadId,
          });
        }
        if (method === "POST" && segments[3] === "messages" && segments.length === 4) {
          const input = await readJson(request);
          return json(
            response,
            202,
            await this.conversationRegistry.addMessage(
              threadId,
              readPrompt(input),
              readResearchSkill(input),
              readResearchTurnOptions(input),
            ),
          );
        }
        throw new ApiRequestError(404, "NOT_FOUND", "Route not found.");
      }
      if (segments[0] === "api" && segments[1] === "turns") {
        const turnId = segments[2];
        if (turnId === undefined) {
          throw new ApiRequestError(404, "TURN_NOT_FOUND", "Research turn not found.");
        }
        if (method === "GET" && segments.length === 3) {
          const turn = this.conversationRegistry.getTurn(turnId);
          if (turn === undefined) {
            throw new ApiRequestError(404, "TURN_NOT_FOUND", "Research turn not found.");
          }
          return json(response, 200, turn);
        }
        if (method === "POST" && segments[3] === "cancel" && segments.length === 4) {
          const result = this.conversationRegistry.cancelTurn(turnId);
          if (result === "not-found") {
            throw new ApiRequestError(404, "TURN_NOT_FOUND", "Research turn not found.");
          }
          return json(response, result === "accepted" ? 202 : 200, {
            cancelled: result === "accepted",
            status: result,
            turnId,
          });
        }
        if (method === "GET" && segments[3] === "events" && segments.length === 4) {
          const afterId = resolveAfterId(request, url);
          return this.streamTurnEvents(response, turnId, afterId);
        }
        throw new ApiRequestError(404, "NOT_FOUND", "Route not found.");
      }
      if (segments[0] !== "api" || segments[1] !== "runs") {
        throw new ApiRequestError(404, "NOT_FOUND", "Route not found.");
      }
      if (method === "POST" && segments.length === 2) {
        const input = await readJson(request);
        const prompt = readPrompt(input);
        return json(response, 202, this.registry.create(prompt));
      }

      const runId = segments[2];
      if (runId === undefined) {
        throw new ApiRequestError(404, "NOT_FOUND", "Route not found.");
      }
      if (method === "GET" && segments.length === 3) {
        const run = this.registry.get(runId);
        if (run === undefined) {
          throw new ApiRequestError(404, "RUN_NOT_FOUND", "Research run not found.");
        }
        return json(response, 200, run);
      }
      if (method === "POST" && segments[3] === "cancel" && segments.length === 4) {
        const result = this.registry.cancel(runId);
        if (result === "not-found") {
          throw new ApiRequestError(404, "RUN_NOT_FOUND", "Research run not found.");
        }
        return json(response, result === "accepted" ? 202 : 200, {
          cancelled: result === "accepted",
          runId,
          status: result,
        });
      }
      if (method === "GET" && segments[3] === "events" && segments.length === 4) {
        const afterId = resolveAfterId(request, url);
        return this.streamEvents(response, runId, afterId);
      }

      throw new ApiRequestError(404, "NOT_FOUND", "Route not found.");
    } catch (error) {
      if (error instanceof ApiRequestError) {
        return json(response, error.status, {
          code: error.code,
          message: error.message,
          requestId,
        });
      }
      if (error instanceof RunValidationError) {
        return json(response, 400, {
          code: "INVALID_RUN",
          message: error.message,
          requestId,
        });
      }
      if (error instanceof ConversationConflictError) {
        return json(response, 409, {
          code: "ACTIVE_TURN",
          message: error.message,
          requestId,
        });
      }
      if (error instanceof ConversationValidationError) {
        return json(response, 400, {
          code: "INVALID_CONVERSATION",
          message: error.message,
          requestId,
        });
      }

      return json(response, 400, {
        code: "REQUEST_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId,
      });
    }
  }

  private streamEvents(response: ServerResponse, runId: string, afterId: number): void {
    if (this.registry.get(runId) === undefined) {
      throw new ApiRequestError(404, "RUN_NOT_FOUND", "Research run not found.");
    }

    response.writeHead(200, {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    });

    let closed = false;
    let heartbeat: NodeJS.Timeout | undefined;
    let unsubscribe: (() => void) | undefined;
    const cleanup = () => {
      if (closed) {
        return;
      }
      closed = true;
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
      }
      unsubscribe?.();
    };
    const write = (event: RunStreamEvent) => {
      if (closed) {
        return;
      }
      writeSse(response, event);
      if (event.type === "status" && isTerminal(event.data.status)) {
        cleanup();
        response.end();
      }
    };

    unsubscribe = this.registry.subscribe(runId, afterId, write);
    if (!closed) {
      heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
      response.once("close", cleanup);
    } else {
      unsubscribe?.();
    }
  }

  private async observatoryStatus(): Promise<{
    readonly available: boolean;
    readonly url: string;
  }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 750);
    try {
      const response = await this.request(new URL("/api/health", this.observatoryApiUrl), {
        headers: {
          Accept: "application/json",
        },
        signal: controller.signal,
      });
      return {
        available: response.ok,
        url: this.observatoryWebUrl,
      };
    } catch {
      return {
        available: false,
        url: this.observatoryWebUrl,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private streamTurnEvents(response: ServerResponse, turnId: string, afterId: number): void {
    if (this.conversationRegistry.getTurn(turnId) === undefined) {
      throw new ApiRequestError(404, "TURN_NOT_FOUND", "Research turn not found.");
    }
    response.writeHead(200, {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    });
    let closed = false;
    let heartbeat: NodeJS.Timeout | undefined;
    let unsubscribe: (() => void) | undefined;
    const cleanup = () => {
      if (closed) {
        return;
      }
      closed = true;
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
      }
      unsubscribe?.();
    };
    const write = (event: RunStreamEvent) => {
      if (closed) {
        return;
      }
      writeSse(response, event);
      if (event.type === "status" && isTerminal(event.data.status)) {
        cleanup();
        response.end();
      }
    };
    unsubscribe = this.conversationRegistry.subscribeTurn(turnId, afterId, write);
    if (!closed) {
      heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
      response.once("close", cleanup);
    } else {
      unsubscribe?.();
    }
  }
}

class ApiRequestError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!request.headers["content-type"]?.includes("application/json")) {
    throw new ApiRequestError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Content-Type must be application/json.",
    );
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new ApiRequestError(413, "REQUEST_TOO_LARGE", "Request body must not exceed 16 KiB.");
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ApiRequestError(400, "INVALID_JSON", "Request body must contain valid JSON.");
  }
}

function readPrompt(input: unknown): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ApiRequestError(400, "INVALID_REQUEST", "Request body must be an object.");
  }

  const prompt = (input as Record<string, unknown>).prompt;
  if (typeof prompt !== "string") {
    throw new ApiRequestError(400, "INVALID_REQUEST", "Prompt must be a string.");
  }

  return prompt;
}

function readResearchSkill(input: unknown): ResearchSkillId {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ApiRequestError(400, "INVALID_REQUEST", "Request body must be an object.");
  }
  const skill = (input as Record<string, unknown>).skill;
  if (skill === undefined) {
    return "research";
  }
  if (skill === "research" || skill === "quick-research" || skill === "deep-research") {
    return skill;
  }
  throw new ApiRequestError(400, "INVALID_REQUEST", "Research Skill is not supported.");
}

function readResearchTurnOptions(input: unknown): ResearchTurnOptions {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ApiRequestError(400, "INVALID_REQUEST", "Request body must be an object.");
  }
  const record = input as Record<string, unknown>;
  const instructions = record.instructions;
  const searchContextSize = record.searchContextSize;
  if (instructions !== undefined && typeof instructions !== "string") {
    throw new ApiRequestError(400, "INVALID_REQUEST", "Instructions must be a string.");
  }
  const normalizedInstructions = instructions?.trim();
  if (
    normalizedInstructions !== undefined &&
    Buffer.byteLength(normalizedInstructions, "utf8") > 4 * 1024
  ) {
    throw new ApiRequestError(400, "INVALID_REQUEST", "Instructions must not exceed 4 KiB.");
  }
  if (
    searchContextSize !== undefined &&
    searchContextSize !== "low" &&
    searchContextSize !== "medium" &&
    searchContextSize !== "high"
  ) {
    throw new ApiRequestError(
      400,
      "INVALID_REQUEST",
      "Search context size must be low, medium, or high.",
    );
  }
  return {
    ...(normalizedInstructions ? { instructions: normalizedInstructions } : {}),
    ...(searchContextSize !== undefined ? { searchContextSize } : {}),
  };
}

function readOptionalTitle(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ApiRequestError(400, "INVALID_REQUEST", "Request body must be an object.");
  }
  const title = (input as Record<string, unknown>).title;
  if (title === undefined) {
    return undefined;
  }
  if (typeof title !== "string") {
    throw new ApiRequestError(400, "INVALID_REQUEST", "Thread title must be a string.");
  }
  return title;
}

function resolveAfterId(request: IncomingMessage, url: URL): number {
  const raw = url.searchParams.get("after") ?? request.headers["last-event-id"] ?? "0";
  const afterId = Number(raw);

  if (!Number.isSafeInteger(afterId) || afterId < 0) {
    throw new ApiRequestError(400, "INVALID_EVENT_ID", "Event ID must be a non-negative integer.");
  }

  return afterId;
}

function writeSse(response: ServerResponse, event: RunStreamEvent): void {
  response.write(`id: ${event.id}\n`);
  response.write("event: run-event\n");
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function isTerminal(status: string): boolean {
  return status === "cancelled" || status === "completed" || status === "failed";
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

function loopbackUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid loopback HTTP URL.`);
  }
  const loopbackHosts = new Set(["127.0.0.1", "[::1]", "localhost"]);
  if (
    url.protocol !== "http:" ||
    !loopbackHosts.has(url.hostname.toLowerCase()) ||
    url.username ||
    url.password
  ) {
    throw new Error(`${label} must be a valid loopback HTTP URL.`);
  }
  return url.toString();
}
