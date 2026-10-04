import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StudioServer, studioManifest } from "../../src/server/studio-server.js";
import type { StoredStudioRun, StudioServerPlugin, StudioStore } from "../../src/server/types.js";
import type { JsonValue, StudioEvent, StudioRunSummary } from "../../src/types.js";

class MemoryStore implements StudioStore {
  public readonly events: StudioEvent[] = [];
  public readonly runs: StudioRunSummary[] = [];

  public async initialize(): Promise<readonly StoredStudioRun[]> {
    return [];
  }

  public async appendEvent(event: StudioEvent): Promise<void> {
    this.events.push(event);
  }

  public async writeRun(run: StudioRunSummary): Promise<void> {
    this.runs.push(run);
  }

  public async close(): Promise<void> {}
}

const servers: StudioServer[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("StudioServer", () => {
  it("serves manifests, ingestion, runs and namespaced plugin routes", async () => {
    const plugin: StudioServerPlugin = {
      adapters: [
        {
          id: "sample",
          parse: (value) => {
            const input = value as { readonly runId: string };
            return {
              event: {
                eventId: "event-1",
                occurredAt: "2026-08-07T00:00:01.000Z",
                runId: input.runId,
                sequence: 1,
              },
              seed: {
                createdAt: "2026-08-07T00:00:00.000Z",
                runId: input.runId,
                status: "running",
                title: "Sample",
              },
            };
          },
        },
      ],
      manifest: studioManifest("workspace", "Workspace", ["events", "pages"]),
      routes: [
        {
          handle: () => ({ body: { mode: "local" } }),
          id: "settings",
          method: "GET",
          path: "/settings",
        },
      ],
    };
    const server = new StudioServer({
      plugins: [plugin],
      port: 0,
      store: new MemoryStore(),
    });
    servers.push(server);
    const address = await server.start();
    const base = `http://${address.host}:${address.port}`;

    const manifest = await fetch(`${base}/api/studio/manifest`).then((response) => response.json());
    expect(manifest).toEqual([plugin.manifest]);

    const ingest = await fetch(`${base}/api/studio/ingest/sample`, {
      body: JSON.stringify({ runId: "run-1" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(ingest.status).toBe(202);

    const runs = await fetch(`${base}/api/studio/runs`).then((response) => response.json());
    expect(runs).toEqual([
      expect.objectContaining({ eventCount: 1, runId: "run-1", title: "Sample" }),
    ]);

    const settings = await fetch(`${base}/api/plugins/workspace/settings`).then((response) =>
      response.json(),
    );
    expect(settings).toEqual({ mode: "local" });
  });

  it("returns structured client and internal errors", async () => {
    const plugin: StudioServerPlugin = {
      manifest: studioManifest("broken", "Broken", ["routes"]),
      routes: [
        {
          handle: () => {
            throw new Error("secret");
          },
          id: "broken",
          method: "GET",
          path: "/broken",
        },
      ],
    };
    const server = new StudioServer({ plugins: [plugin], port: 0, store: new MemoryStore() });
    servers.push(server);
    const address = await server.start();
    const base = `http://${address.host}:${address.port}`;

    const missing = await fetch(`${base}/api/studio/runs/missing`);
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual(
      expect.objectContaining({ code: "STUDIO_RUN_NOT_FOUND" }),
    );

    const broken = await fetch(`${base}/api/plugins/broken/broken`);
    expect(broken.status).toBe(500);
    const body = (await broken.json()) as { readonly message: string; readonly requestId: string };
    expect(body.message).toBe("Studio request failed.");
    expect(body.requestId).toBeTruthy();
  });

  it("validates stores, routes and contribution ownership at composition time", () => {
    const store = new MemoryStore();
    expect(
      () =>
        new StudioServer({
          plugins: [{ manifest: studioManifest("store", "Store", []), store }],
          store,
        }),
    ).toThrow("both the host");
    expect(
      () =>
        new StudioServer({
          plugins: [
            { manifest: studioManifest("one", "One", []), store: new MemoryStore() },
            { manifest: studioManifest("two", "Two", []), store: new MemoryStore() },
          ],
        }),
    ).toThrow("multiple plugins");
    expect(
      () =>
        new StudioServer({
          plugins: [
            {
              adapters: [{ id: "same", parse: () => adaptedEvent("run-1") }],
              manifest: studioManifest("one", "One", []),
            },
            {
              adapters: [{ id: "same", parse: () => adaptedEvent("run-2") }],
              manifest: studioManifest("two", "Two", []),
            },
          ],
          store,
        }),
    ).toThrow("Event adapter");
    expect(
      () =>
        new StudioServer({
          plugins: [
            {
              manifest: studioManifest("route", "Route", []),
              routes: [
                {
                  handle: () => ({}),
                  id: "bad",
                  method: "GET",
                  path: "/../bad",
                },
              ],
            },
          ],
          store,
        }),
    ).toThrow("Invalid plugin route");
  });

  it("serves static assets, SPA fallbacks and HEAD responses", async () => {
    const staticDir = createTempDir();
    mkdirSync(join(staticDir, "assets"), { recursive: true });
    writeFileSync(join(staticDir, "index.html"), "<main>Studio</main>");
    writeFileSync(join(staticDir, "assets", "app.css"), "body {}");
    writeFileSync(join(staticDir, "assets", "data.bin"), "data");
    const server = new StudioServer({
      port: 0,
      staticDir,
      store: new MemoryStore(),
    });
    servers.push(server);
    const address = await server.start();
    const base = `http://${address.host}:${address.port}`;

    await expect(fetch(base).then((response) => response.text())).resolves.toContain("Studio");
    await expect(
      fetch(`${base}/runs/example`).then((response) => response.text()),
    ).resolves.toContain("Studio");
    const head = await fetch(`${base}/`, { method: "HEAD" });
    expect(await head.text()).toBe("");
    expect(head.headers.get("cache-control")).toBe("no-cache");
    const css = await fetch(`${base}/assets/app.css`);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(css.headers.get("cache-control")).toContain("immutable");
    expect((await fetch(`${base}/assets/data.bin`)).headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
    await expect(server.start()).rejects.toMatchObject({ code: "STUDIO_ALREADY_RUNNING" });

    const missing = new StudioServer({
      port: 0,
      staticDir: join(staticDir, "missing"),
      store: new MemoryStore(),
    });
    servers.push(missing);
    await expect(missing.start()).rejects.toMatchObject({ code: "STUDIO_ASSETS_MISSING" });
  });

  it("covers request validation, route parameters, duplicate events and SSE", async () => {
    const plugin: StudioServerPlugin = {
      adapters: [{ id: "sample", parse: () => adaptedEvent("run-1") }],
      manifest: studioManifest("routes", "Routes", ["events", "routes"]),
      routes: [
        {
          handle: async ({ body, params, query }) => {
            const first = await body();
            const second = await body();
            return {
              body: {
                first: first as JsonValue,
                id: params.id ?? "",
                query: query.get("mode") ?? "",
                same: first === second,
              },
              headers: { "X-Studio-Test": "yes" },
              status: 201,
            };
          },
          id: "echo",
          method: "POST",
          path: "/echo/:id",
        },
        {
          handle: () => ({ status: 204 }),
          id: "empty",
          method: "GET",
          path: "/empty",
        },
      ],
    };
    const server = new StudioServer({ plugins: [plugin], port: 0, store: new MemoryStore() });
    servers.push(server);
    const address = await server.start();
    const base = `http://${address.host}:${address.port}`;

    expect((await fetch(`${base}/api/studio/ingest/missing`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${base}/api/studio/ingest/sample`, { method: "POST" })).status).toBe(415);
    expect(
      (
        await fetch(`${base}/api/studio/ingest/sample`, {
          body: "{",
          headers: { "Content-Type": "application/json" },
          method: "POST",
        })
      ).status,
    ).toBe(400);
    const accepted = await fetch(`${base}/api/studio/ingest/sample`, {
      body: "{}",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(accepted.status).toBe(202);
    const duplicate = await fetch(`${base}/api/studio/ingest/sample`, {
      body: "{}",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(duplicate.status).toBe(200);
    expect((await fetch(`${base}/api/studio/runs`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/api/studio/runs/run-1/events?after=-1`)).status).toBe(400);
    await expect(
      fetch(`${base}/api/studio/runs/run-1/events`).then((response) => response.json()),
    ).resolves.toHaveLength(1);

    const echo = await fetch(`${base}/api/plugins/routes/echo/value?mode=full`, {
      body: JSON.stringify({ ok: true }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(echo.status).toBe(201);
    expect(echo.headers.get("x-studio-test")).toBe("yes");
    await expect(echo.json()).resolves.toEqual({
      first: { ok: true },
      id: "value",
      query: "full",
      same: true,
    });
    expect((await fetch(`${base}/api/plugins/routes/empty`)).status).toBe(204);
    expect((await fetch(`${base}/api/plugins/routes/missing`)).status).toBe(404);

    const missingStream = await fetch(`${base}/api/studio/runs/missing/events`, {
      headers: { Accept: "text/event-stream" },
    });
    expect(missingStream.status).toBe(404);
    const stream = await fetch(`${base}/api/studio/runs/run-1/events`, {
      headers: { Accept: "text/event-stream" },
    });
    expect(stream.status).toBe(200);
    const reader = stream.body?.getReader();
    const chunk = await reader?.read();
    expect(new TextDecoder().decode(chunk?.value)).toContain("event: studio-event");
    await reader?.cancel();
  });

  it("enforces body limits and aggregates plugin disposal failures", async () => {
    const disposeError = new Error("dispose failed");
    const plugin: StudioServerPlugin = {
      adapters: [{ id: "sample", parse: () => adaptedEvent("run-1") }],
      dispose: () => {
        throw disposeError;
      },
      manifest: studioManifest("lifecycle", "Lifecycle", []),
    };
    const server = new StudioServer({
      maxBodyBytes: 2,
      plugins: [plugin],
      port: 0,
      store: new MemoryStore(),
    });
    servers.push(server);
    const address = await server.start();
    const response = await fetch(
      `http://${address.host}:${address.port}/api/studio/ingest/sample`,
      {
        body: "123",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
    );
    expect(response.status).toBe(413);

    await expect(server.close()).rejects.toEqual(
      expect.objectContaining({
        errors: [disposeError],
      }),
    );
    servers.splice(servers.indexOf(server), 1);
  });

  it("rejects non-loopback hosts", async () => {
    const server = new StudioServer({
      host: "0.0.0.0",
      port: 0,
      store: new MemoryStore(),
    });
    servers.push(server);

    await expect(server.start()).rejects.toMatchObject({
      code: "STUDIO_HOST_RESTRICTED",
    });
  });
});

function adaptedEvent(runId: string) {
  return {
    event: {
      eventId: "event-1",
      occurredAt: "2026-08-07T00:00:01.000Z",
      runId,
      sequence: 1,
    },
    seed: {
      createdAt: "2026-08-07T00:00:00.000Z",
      runId,
      status: "running",
      title: "Sample",
    },
  };
}

function createTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "agent-studio-server-"));
  directories.push(directory);
  return directory;
}
