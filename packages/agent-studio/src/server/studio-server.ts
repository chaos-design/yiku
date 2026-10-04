import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  assertUniqueContributions,
  orderStudioPlugins,
  StudioPluginError,
} from "../plugin-registry.js";
import type { StudioEvent, StudioPluginManifest } from "../types.js";
import { StudioError } from "./errors.js";
import { FileStudioStore } from "./file-studio-store.js";
import { StudioRunRegistry } from "./run-registry.js";
import type {
  StudioEventAdapter,
  StudioRoute,
  StudioRouteResponse,
  StudioServerPlugin,
  StudioServerPluginContext,
  StudioStore,
} from "./types.js";

const DEFAULT_MAX_BODY_BYTES = 128 * 1024;
const STUDIO_VERSION = "0.1";

export interface StudioServerOptions {
  readonly host?: string | undefined;
  readonly maxBodyBytes?: number | undefined;
  readonly plugins?: readonly StudioServerPlugin[] | undefined;
  readonly port?: number | undefined;
  readonly staticDir?: string | undefined;
  readonly store?: StudioStore | undefined;
  readonly workspaceDir?: string | undefined;
}

interface RegisteredRoute {
  readonly pluginId: string;
  readonly route: StudioRoute;
  readonly segments: readonly string[];
}

export class StudioServer {
  private readonly adapters = new Map<string, StudioEventAdapter>();
  private readonly host: string;
  private readonly initializedPlugins: StudioServerPlugin[] = [];
  private readonly maxBodyBytes: number;
  private readonly plugins: readonly StudioServerPlugin[];
  private readonly port: number;
  private readonly registry: StudioRunRegistry;
  private readonly routes: readonly RegisteredRoute[];
  private server: Server | undefined;
  private readonly staticDir: string | undefined;
  private readonly streams = new Set<ServerResponse>();

  public constructor(options: StudioServerOptions = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 4318;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.staticDir = options.staticDir === undefined ? undefined : resolve(options.staticDir);
    this.plugins = orderStudioPlugins(options.plugins ?? [], STUDIO_VERSION);

    const adapters = this.plugins.flatMap((plugin) =>
      (plugin.adapters ?? []).map((adapter) => ({
        id: adapter.id,
        pluginId: plugin.manifest.id,
        value: adapter,
      })),
    );
    const projectors = this.plugins.flatMap((plugin) =>
      (plugin.projectors ?? []).map((projector) => ({
        id: projector.id,
        pluginId: plugin.manifest.id,
        value: projector,
      })),
    );
    const statuses = this.plugins.flatMap((plugin) =>
      (plugin.statuses ?? []).map((status) => ({
        id: status.key,
        pluginId: plugin.manifest.id,
      })),
    );
    const routes = this.plugins.flatMap((plugin) =>
      (plugin.routes ?? []).map((route) => ({
        id: `${route.method} ${route.path}`,
        pluginId: plugin.manifest.id,
        route,
      })),
    );
    assertUniqueContributions("Event adapter", adapters);
    assertUniqueContributions("Run projector", projectors);
    assertUniqueContributions("Status", statuses);
    assertUniqueContributions("Plugin route", routes);
    for (const entry of adapters) {
      this.adapters.set(entry.id, entry.value);
    }
    this.routes = routes.map((entry) => ({
      pluginId: entry.pluginId,
      route: entry.route,
      segments: routeSegments(entry.route.path),
    }));

    const pluginStores = this.plugins.flatMap((plugin) =>
      plugin.store === undefined ? [] : [{ pluginId: plugin.manifest.id, store: plugin.store }],
    );
    if (options.store !== undefined && pluginStores.length > 0) {
      throw new StudioPluginError(
        "PLUGIN_DUPLICATE",
        `Studio Store is provided by both the host and plugin "${pluginStores[0]?.pluginId}".`,
      );
    }
    if (pluginStores.length > 1) {
      throw new StudioPluginError(
        "PLUGIN_DUPLICATE",
        `Studio Store is provided by multiple plugins: ${pluginStores
          .map((entry) => entry.pluginId)
          .join(", ")}.`,
      );
    }
    const store =
      options.store ??
      pluginStores[0]?.store ??
      new FileStudioStore({
        rootDir: join(resolve(options.workspaceDir ?? process.cwd()), ".yiku", "studio-runs"),
      });
    this.registry = new StudioRunRegistry({
      projectors: projectors.map((entry) => entry.value),
      store,
    });
  }

  public async start(): Promise<{ readonly host: string; readonly port: number }> {
    if (this.host !== "127.0.0.1" && this.host !== "localhost") {
      throw new StudioError(400, "STUDIO_HOST_RESTRICTED", "Studio only binds to loopback.");
    }
    if (this.server !== undefined) {
      throw new StudioError(409, "STUDIO_ALREADY_RUNNING", "Studio Server is already running.");
    }
    if (this.staticDir !== undefined) {
      await requireStaticIndex(this.staticDir);
    }

    await this.registry.initialize();
    const context: StudioServerPluginContext = { registry: this.registry };
    try {
      for (const plugin of this.plugins) {
        await plugin.initialize?.(context);
        this.initializedPlugins.push(plugin);
      }

      const server = createServer((request, response) => {
        void this.handle(request, response);
      });
      this.server = server;
      await new Promise<void>((resolveStart, reject) => {
        server.once("error", reject);
        server.listen(this.port, this.host, () => {
          server.off("error", reject);
          resolveStart();
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
        await new Promise<void>((resolveClose, reject) => {
          server.close((error) => (error ? reject(error) : resolveClose()));
        });
      } catch (error) {
        errors.push(error);
      }
    }

    const context: StudioServerPluginContext = { registry: this.registry };
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
    if (errors.length > 0) {
      throw new AggregateError(errors, "Studio Server failed to close cleanly.");
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", `http://${this.host}`);
      const segments = url.pathname.split("/").filter(Boolean);

      if (method === "GET" && url.pathname === "/api/studio/health") {
        return json(response, 200, { status: "ok" });
      }
      if (method === "GET" && url.pathname === "/api/studio/manifest") {
        return json(
          response,
          200,
          this.plugins.map((plugin) => plugin.manifest),
        );
      }
      if (
        method === "POST" &&
        segments[0] === "api" &&
        segments[1] === "studio" &&
        segments[2] === "ingest"
      ) {
        const adapterId = segments[3];
        const adapter = adapterId === undefined ? undefined : this.adapters.get(adapterId);
        if (adapter === undefined || segments.length !== 4) {
          throw new StudioError(404, "STUDIO_ADAPTER_NOT_FOUND", "Event adapter not found.");
        }
        const input = await readJson(request, this.maxBodyBytes);
        const parsed = await adapter.parse(input);
        const result = await this.registry.ingest(parsed.event, parsed.seed);
        return json(response, result.duplicate ? 200 : 202, result);
      }
      if (segments[0] === "api" && segments[1] === "studio" && segments[2] === "runs") {
        if (method !== "GET") {
          throw new StudioError(405, "STUDIO_METHOD_NOT_ALLOWED", "Method not allowed.");
        }
        if (segments.length === 3) {
          return json(response, 200, this.registry.list());
        }
        const runId = segments[3];
        if (runId === undefined) {
          throw new StudioError(400, "STUDIO_RUN_REQUIRED", "Run ID is required.");
        }
        if (segments[4] === "events" && segments.length === 5) {
          const after = afterSequence(request, url);
          if (request.headers.accept?.includes("text/event-stream")) {
            return this.streamEvents(response, runId, after);
          }
          return json(response, 200, this.registry.events(runId, after));
        }
        if (segments.length === 4) {
          const run = this.registry.get(runId);
          if (run === undefined) {
            throw new StudioError(404, "STUDIO_RUN_NOT_FOUND", "Run not found.");
          }
          return json(response, 200, run);
        }
      }
      if (segments[0] === "api" && segments[1] === "plugins") {
        return await this.handlePluginRoute(request, response, url, segments);
      }
      if ((method === "GET" || method === "HEAD") && segments[0] !== "api") {
        return await this.serveStatic(response, url.pathname, method === "HEAD");
      }
      throw new StudioError(404, "STUDIO_NOT_FOUND", "Route not found.");
    } catch (error) {
      const studioError =
        error instanceof StudioError
          ? error
          : new StudioError(500, "STUDIO_INTERNAL_ERROR", "Studio request failed.");
      return json(response, studioError.status, {
        code: studioError.code,
        ...(studioError.details === undefined ? {} : { details: studioError.details }),
        message: studioError.message,
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
        bodyPromise ??= readJson(request, this.maxBodyBytes);
        return bodyPromise;
      },
      params: routeParams(registration.segments, pathSegments),
      query: url.searchParams,
      registry: this.registry,
      request,
      url,
    });
    writeRouteResponse(response, result);
  }

  private streamEvents(response: ServerResponse, runId: string, after: number): void {
    if (this.registry.get(runId) === undefined) {
      throw new StudioError(404, "STUDIO_RUN_NOT_FOUND", "Run not found.");
    }
    response.writeHead(200, {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();
    this.streams.add(response);
    for (const event of this.registry.events(runId, after)) {
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

  private async serveStatic(
    response: ServerResponse,
    pathname: string,
    headOnly: boolean,
  ): Promise<void> {
    const staticDir = this.staticDir;
    if (staticDir === undefined) {
      throw new StudioError(404, "STUDIO_NOT_FOUND", "Route not found.");
    }
    const decodedPath = decodeURIComponent(pathname);
    const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/u, "");
    const candidate = resolve(staticDir, relativePath);
    const filePath = isWithin(staticDir, candidate)
      ? await resolveStaticFile(staticDir, candidate, relativePath)
      : undefined;
    if (filePath === undefined) {
      throw new StudioError(404, "STUDIO_ASSET_NOT_FOUND", "Asset not found.");
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
}

function writeRouteResponse(response: ServerResponse, result: StudioRouteResponse): void {
  const status = result.status ?? 200;
  if (result.body === undefined) {
    response.writeHead(status, result.headers);
    response.end();
    return;
  }
  json(response, status, result.body, result.headers);
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

async function readJson(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
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
    if (size > maxBodyBytes) {
      throw new StudioError(413, "STUDIO_REQUEST_TOO_LARGE", "Request body is too large.");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new StudioError(400, "STUDIO_INVALID_JSON", "Request body must contain valid JSON.");
  }
}

function afterSequence(request: IncomingMessage, url: URL): number {
  const raw = url.searchParams.get("after") ?? request.headers["last-event-id"] ?? "0";
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new StudioError(400, "STUDIO_SEQUENCE_INVALID", "Sequence must be non-negative.");
  }
  return value;
}

function writeSse(response: ServerResponse, event: StudioEvent): void {
  response.write(`id: ${event.sequence}\n`);
  response.write("event: studio-event\n");
  response.write(`data: ${JSON.stringify(event)}\n\n`);
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

async function requireStaticIndex(staticDir: string): Promise<void> {
  const indexPath = join(staticDir, "index.html");
  try {
    if (!(await stat(indexPath)).isFile()) {
      throw new Error();
    }
  } catch {
    throw new StudioError(500, "STUDIO_ASSETS_MISSING", `Studio assets are missing: ${indexPath}`);
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
  const types: Readonly<Record<string, string>> = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
  };
  return types[extname(filePath)] ?? "application/octet-stream";
}

export function studioManifest(
  id: string,
  name: string,
  capabilities: readonly string[],
): StudioPluginManifest {
  return {
    capabilities,
    id,
    name,
    studioVersion: STUDIO_VERSION,
    version: "0.1.0",
  };
}
