import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertUniqueContributions, orderStudioPlugins } from "@yiku/agent-studio";
import {
  StudioError,
  type StudioRoute,
  type StudioServerPlugin,
  type StudioServerPluginContext,
} from "@yiku/agent-studio/server";
import type { AtomicFlowEvent } from "@yiku/atomic-flow";
import { YikuPaths } from "@yiku/config";
import { IngestionError, parseIngestEvent } from "./ingestion.js";
import { AGENT_OBSERVATORY_SERVER_MANIFEST } from "./plugin.js";
import { RunRegistry } from "./run-registry.js";

const MAX_BODY_BYTES = 128 * 1024;
const BROWSER_PRESENCE_TTL_MS = 5_000;

export interface ApiServerOptions {
  readonly homeDir?: string | undefined;
  readonly host?: string | undefined;
  readonly plugins?: readonly StudioServerPlugin[] | undefined;
  readonly port?: number | undefined;
  readonly staticDir?: string | undefined;
  readonly runsDir?: string | undefined;
  readonly workspaceDir: string;
}

interface RegisteredRoute {
  readonly pluginId: string;
  readonly route: StudioRoute;
  readonly segments: readonly string[];
}

export class ApiServer {
  private readonly host: string;
  private readonly initializedPlugins: StudioServerPlugin[] = [];
  private readonly plugins: readonly StudioServerPlugin[];
  private readonly port: number;
  private readonly registry: RunRegistry;
  private readonly testRegistry: RunRegistry;
  private readonly routes: readonly RegisteredRoute[];
  private readonly staticDir: string | undefined;
  private browserSeenAt: number | undefined;
  private server: Server | undefined;
  private readonly streams = new Set<ServerResponse>();

  public constructor(options: ApiServerOptions) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 4318;
    const runsDir = resolve(
      options.runsDir ??
        new YikuPaths({
          ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
          workspaceDir: options.workspaceDir,
        }).runsDir,
    );
    this.registry = new RunRegistry({
      runsDir,
      workspaceDir: options.workspaceDir,
    });
    this.testRegistry = new RunRegistry({
      runsDir: join(runsDir, "tests"),
      workspaceDir: options.workspaceDir,
    });
    this.staticDir = options.staticDir === undefined ? undefined : resolve(options.staticDir);
    this.plugins = orderStudioPlugins(
      [{ manifest: AGENT_OBSERVATORY_SERVER_MANIFEST }, ...(options.plugins ?? [])],
      "0.1",
    );
    const routes = this.plugins.flatMap((plugin) =>
      (plugin.routes ?? []).map((route) => ({
        id: `${route.method} ${route.path}`,
        pluginId: plugin.manifest.id,
        route,
      })),
    );
    assertUniqueContributions("Plugin route", routes);
    this.routes = routes.map((entry) => ({
      pluginId: entry.pluginId,
      route: entry.route,
      segments: routeSegments(entry.route.path),
    }));
  }

  public async start(): Promise<{ readonly host: string; readonly port: number }> {
    if (this.host !== "127.0.0.1" && this.host !== "localhost") {
      throw new Error("Yiku Agent Observatory only binds to loopback by default.");
    }
    if (this.staticDir !== undefined) {
      await requireStaticIndex(this.staticDir);
    }
    await Promise.all([this.registry.initialize(), this.testRegistry.initialize()]);
    const context: StudioServerPluginContext = {
      registry: this.registry.studioRegistry(),
    };
    try {
      for (const plugin of this.plugins) {
        await plugin.initialize?.(context);
        this.initializedPlugins.push(plugin);
      }
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
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  public async close(): Promise<void> {
    const errors: unknown[] = [];
    for (const response of this.streams) {
      response.end();
    }
    this.streams.clear();
    const server = this.server;
    this.server = undefined;
    if (server !== undefined) {
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      } catch (error) {
        errors.push(error);
      }
    }
    const context: StudioServerPluginContext = {
      registry: this.registry.studioRegistry(),
    };
    for (const plugin of this.initializedPlugins.toReversed()) {
      try {
        await plugin.dispose?.(context);
      } catch (error) {
        errors.push(error);
      }
    }
    this.initializedPlugins.length = 0;
    try {
      await this.registry.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.testRegistry.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Yiku Agent Observatory failed to close cleanly.");
    }
  }

  public hasBrowserClient(): boolean {
    return (
      this.browserSeenAt !== undefined && Date.now() - this.browserSeenAt <= BROWSER_PRESENCE_TTL_MS
    );
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
      if (method === "POST" && url.pathname === "/api/browser-presence") {
        this.browserSeenAt = Date.now();
        return json(response, 200, { status: "ok" });
      }
      if (method === "GET" && url.pathname === "/api/studio/manifest") {
        return json(
          response,
          200,
          this.plugins.map((plugin) => plugin.manifest),
        );
      }
      if (method === "POST" && url.pathname === "/api/ingest/events") {
        const input = parseIngestEvent(await readJson<unknown>(request));
        const result = await this.registry.ingest(input);
        return json(response, result.duplicate ? 200 : 202, result);
      }
      if (method === "POST" && url.pathname === "/tests/api/ingest/events") {
        const input = parseIngestEvent(await readJson<unknown>(request));
        const result = await this.testRegistry.ingest(input);
        return json(response, result.duplicate ? 200 : 202, result);
      }
      if (segments[0] === "api" && segments[1] === "plugins") {
        return await this.handlePluginRoute(request, response, url, segments);
      }
      if ((method === "GET" || method === "HEAD") && segments[0] !== "api") {
        return await this.serveStatic(response, url.pathname, method === "HEAD");
      }
      if (segments[0] !== "api" || segments[1] !== "runs") {
        return json(response, 404, { code: "NOT_FOUND", message: "Route not found.", requestId });
      }
      if (method !== "GET") {
        return json(response, 405, {
          code: "STUDIO_READ_ONLY",
          message: "Yiku Agent Observatory only observes CLI runs.",
          requestId,
        });
      }
      if (method === "GET" && segments.length === 2) {
        return json(response, 200, await this.registry.list());
      }

      const runId = segments[2];
      if (runId === undefined) {
        return json(response, 400, {
          code: "INVALID_RUN",
          message: "Run ID is required.",
          requestId,
        });
      }
      if (method === "GET" && segments[3] === "memories") {
        return json(response, 200, await this.registry.memoryEvents(runId));
      }
      if (method === "GET" && segments[3] === "events") {
        const after = resolveAfterSequence(request, url);
        if (request.headers.accept?.includes("text/event-stream")) {
          return await this.streamEvents(response, runId, after);
        }
        return json(response, 200, await this.registry.events(runId, after));
      }
      if (method === "GET" && segments.length === 3) {
        const run = await this.registry.get(runId);
        return run === undefined
          ? json(response, 404, { code: "RUN_NOT_FOUND", message: "Run not found.", requestId })
          : json(response, 200, run);
      }

      return json(response, 404, { code: "NOT_FOUND", message: "Route not found.", requestId });
    } catch (error) {
      if (error instanceof IngestionError) {
        return json(response, error.status, {
          code: error.code,
          ...(error.expectedSequence !== undefined
            ? { expectedSequence: error.expectedSequence }
            : {}),
          message: error.message,
          requestId,
        });
      }
      if (error instanceof StudioError) {
        return json(response, error.status, {
          code: error.code,
          ...(error.details === undefined ? {} : { details: error.details }),
          message: error.message,
          requestId,
        });
      }
      return json(response, 500, {
        code: "STUDIO_INTERNAL_ERROR",
        message: "Yiku Agent Observatory request failed.",
        requestId,
      });
    }
  }

  private async handlePluginRoute(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    segments: readonly string[],
  ): Promise<void> {
    const pluginId = segments[2];
    if (pluginId === undefined) {
      throw new StudioError(404, "STUDIO_PLUGIN_NOT_FOUND", "Plugin route not found.");
    }
    const pathSegments = segments.slice(3);
    const registration = this.routes.find(
      (candidate) =>
        candidate.pluginId === pluginId &&
        candidate.route.method === (request.method ?? "GET") &&
        routeMatches(candidate.segments, pathSegments),
    );
    if (registration === undefined) {
      throw new StudioError(404, "STUDIO_PLUGIN_ROUTE_NOT_FOUND", "Plugin route not found.");
    }
    let bodyPromise: Promise<unknown> | undefined;
    const result = await registration.route.handle({
      body: () => {
        bodyPromise ??= readJson<unknown>(request);
        return bodyPromise;
      },
      params: routeParams(registration.segments, pathSegments),
      query: url.searchParams,
      registry: this.registry.studioRegistry(),
      request,
      url,
    });
    if (result.body === undefined) {
      response.writeHead(result.status ?? 200, result.headers);
      response.end();
      return;
    }
    json(response, result.status ?? 200, result.body, result.headers);
  }

  private async serveStatic(
    response: ServerResponse,
    pathname: string,
    headOnly: boolean,
  ): Promise<void> {
    const staticDir = this.staticDir;
    if (staticDir === undefined) {
      return json(response, 404, { code: "NOT_FOUND", message: "Route not found." });
    }
    const decodedPath = decodeURIComponent(pathname);
    const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/u, "");
    const candidate = resolve(staticDir, relativePath);
    const filePath = isWithin(staticDir, candidate)
      ? await resolveStaticFile(staticDir, candidate, relativePath)
      : undefined;

    if (filePath === undefined) {
      return text(response, 404, "Not found.");
    }

    const content = await readFile(filePath);
    response.writeHead(200, {
      "Cache-Control":
        filePath === join(staticDir, "index.html")
          ? "no-cache"
          : "public, max-age=31536000, immutable",
      "Content-Length": content.byteLength,
      "Content-Type": contentType(filePath),
    });
    response.end(headOnly ? undefined : content);
  }

  private async streamEvents(
    response: ServerResponse,
    runId: string,
    afterSequence: number,
  ): Promise<void> {
    response.writeHead(200, {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();
    this.streams.add(response);
    for (const event of await this.registry.events(runId, afterSequence)) {
      writeSse(response, event);
    }
    const unsubscribe = this.registry.subscribe(runId, (event) => writeSse(response, event));
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    response.once("close", () => {
      clearInterval(heartbeat);
      this.streams.delete(response);
      unsubscribe?.();
    });
  }
}

function writeSse(response: ServerResponse, event: AtomicFlowEvent): void {
  response.write(`id: ${event.sequence}\n`);
  response.write("event: atomic-flow\n");
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  if (!request.headers["content-type"]?.includes("application/json")) {
    throw new StudioError(
      415,
      "STUDIO_UNSUPPORTED_MEDIA_TYPE",
      "Content-Type must be application/json.",
    );
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new StudioError(413, "STUDIO_REQUEST_TOO_LARGE", "Request body is too large.");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new StudioError(400, "STUDIO_INVALID_JSON", "Request body must contain valid JSON.");
  }
}

function resolveAfterSequence(request: IncomingMessage, url: URL): number {
  const raw = url.searchParams.get("after") ?? request.headers["last-event-id"] ?? "0";
  const after = Number(raw);
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new StudioError(400, "STUDIO_SEQUENCE_INVALID", "Invalid atomic sequence.");
  }
  return after;
}

function json(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function routeSegments(pathname: string): readonly string[] {
  if (!pathname.startsWith("/") || pathname.includes("..")) {
    throw new StudioError(400, "STUDIO_ROUTE_INVALID", `Invalid plugin route "${pathname}".`);
  }
  return pathname.split("/").filter(Boolean);
}

function routeMatches(pattern: readonly string[], value: readonly string[]): boolean {
  return (
    pattern.length === value.length &&
    pattern.every((segment, index) => segment.startsWith(":") || segment === value[index])
  );
}

function routeParams(
  pattern: readonly string[],
  value: readonly string[],
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    pattern.flatMap((segment, index) =>
      segment.startsWith(":") && value[index] !== undefined
        ? [[segment.slice(1), value[index]] as const]
        : [],
    ),
  );
}

function text(response: ServerResponse, status: number, value: string): void {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end(value);
}

async function requireStaticIndex(staticDir: string): Promise<void> {
  const indexPath = join(staticDir, "index.html");
  try {
    if (!(await stat(indexPath)).isFile()) {
      throw new Error();
    }
  } catch {
    throw new Error(`Yiku Agent Observatory assets are missing: ${indexPath}`);
  }
}

async function resolveStaticFile(
  staticDir: string,
  candidate: string,
  relativePath: string,
): Promise<string | undefined> {
  try {
    if ((await stat(candidate)).isFile()) {
      return candidate;
    }
  } catch {
    // Extension-free routes fall back to the single-page application.
  }
  return extname(relativePath) ? undefined : join(staticDir, "index.html");
}

function isWithin(root: string, candidate: string): boolean {
  const boundary = relative(root, candidate);
  return boundary === "" || (!boundary.startsWith("..") && !isAbsolute(boundary));
}

function contentType(filePath: string): string {
  switch (extname(filePath)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

export function resolveWebAssetsDir(): string {
  return fileURLToPath(new URL("../dist", import.meta.url));
}
