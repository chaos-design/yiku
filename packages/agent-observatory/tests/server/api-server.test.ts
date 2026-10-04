import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AtomicFlowEvent } from "@yiku/atomic-flow";
import { afterEach, describe, expect, it } from "vitest";
import { ApiServer } from "../../server/api-server.js";

const directories: string[] = [];
const servers: ApiServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("ApiServer", () => {
  it("serves health and run lists while rejecting Web execution", async () => {
    const server = new ApiServer({
      homeDir: createTempDir(),
      port: 0,
      workspaceDir: createTempDir(),
    });
    servers.push(server);
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;

    expect(server.hasBrowserClient()).toBe(false);
    await expect(
      fetch(`${baseUrl}/api/health`).then((response) => response.json()),
    ).resolves.toEqual({
      status: "ok",
    });
    await expect(
      fetch(`${baseUrl}/api/studio/manifest`).then((response) => response.json()),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "yiku.agent-observatory",
        version: "0.1.0",
      }),
    ]);
    await expect(fetch(`${baseUrl}/api/runs`).then((response) => response.json())).resolves.toEqual(
      [],
    );
    await expect(
      fetch(`${baseUrl}/api/browser-presence`, { method: "POST" }).then((response) =>
        response.json(),
      ),
    ).resolves.toEqual({ status: "ok" });
    expect(server.hasBrowserClient()).toBe(true);
    const response = await fetch(`${baseUrl}/api/runs`, {
      body: JSON.stringify({ prompt: "" }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toMatchObject({
      code: "STUDIO_READ_ONLY",
      message: "Yiku Agent Observatory only observes CLI runs.",
    });
  });

  it("ingests ordered external events and rejects conflicts", async () => {
    const server = new ApiServer({
      homeDir: createTempDir(),
      port: 0,
      workspaceDir: createTempDir(),
    });
    servers.push(server);
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;
    const first = atomicEvent(1, "event-1", "start");

    const accepted = await ingest(baseUrl, first);
    expect(accepted.status).toBe(202);
    await expect(accepted.json()).resolves.toMatchObject({
      duplicate: false,
      expectedSequence: 2,
      runId: "external-run",
    });

    const duplicate = await ingest(baseUrl, first);
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toMatchObject({
      duplicate: true,
      expectedSequence: 2,
    });

    const conflict = await ingest(baseUrl, {
      ...first,
      eventId: "conflict",
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      code: "INGESTION_CONFLICT",
      expectedSequence: 2,
    });

    const gap = await ingest(baseUrl, atomicEvent(3, "event-3", "end"));
    expect(gap.status).toBe(409);
    const completed = await ingest(baseUrl, atomicEvent(2, "event-2", "end"));
    expect(completed.status).toBe(202);

    const detail = await fetch(`${baseUrl}/api/runs/external-run`).then((response) =>
      response.json(),
    );
    expect(detail).toMatchObject({
      eventCount: 2,
      prompt: "Review the CLI flow",
      projectName: "Runtime Project",
      sessionId: "session-1",
      source: "external",
      status: "completed",
    });
    expect(detail.events).toHaveLength(2);

    const cancel = await fetch(`${baseUrl}/api/runs/external-run/cancel`, {
      method: "POST",
    });
    expect(cancel.status).toBe(405);
  });

  it("isolates test ingestion below the runs tests directory", async () => {
    const runsDir = createTempDir();
    const server = new ApiServer({
      port: 0,
      runsDir,
      workspaceDir: createTempDir(),
    });
    servers.push(server);
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;

    const accepted = await ingest(
      baseUrl,
      { ...atomicEvent(1, "test-event-1", "start"), runId: "test-run" },
      "/tests/api/ingest/events",
    );

    expect(accepted.status).toBe(202);
    await expect(fetch(`${baseUrl}/api/runs`).then((response) => response.json())).resolves.toEqual(
      [],
    );
    expect(readdirSync(runsDir)).toEqual(["tests"]);
    expect(readdirSync(join(runsDir, "tests"))).toHaveLength(1);
  });

  it("serves the Web application and API from one port", async () => {
    const workspaceDir = createTempDir();
    const staticDir = join(workspaceDir, "web");
    mkdirSync(join(staticDir, "assets"), { recursive: true });
    writeFileSync(join(staticDir, "index.html"), "<main>Yiku Web</main>");
    writeFileSync(join(staticDir, "assets", "app.js"), "export {};");
    const server = new ApiServer({
      homeDir: createTempDir(),
      port: 0,
      staticDir,
      workspaceDir,
    });
    servers.push(server);
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;

    await expect(fetch(baseUrl).then((response) => response.text())).resolves.toContain("Yiku Web");
    await expect(
      fetch(`${baseUrl}/runs/example`).then((response) => response.text()),
    ).resolves.toContain("Yiku Web");
    const asset = await fetch(`${baseUrl}/assets/app.js`);
    expect(asset.headers.get("content-type")).toContain("text/javascript");
    expect(asset.status).toBe(200);
    expect((await fetch(`${baseUrl}/assets/missing.js`)).status).toBe(404);
    await expect(
      fetch(`${baseUrl}/api/health`).then((response) => response.json()),
    ).resolves.toEqual({ status: "ok" });
  });

  it("closes active SSE streams during shutdown", async () => {
    const server = new ApiServer({
      homeDir: createTempDir(),
      port: 0,
      workspaceDir: createTempDir(),
    });
    servers.push(server);
    const address = await server.start();
    const stream = await fetch(`http://${address.host}:${address.port}/api/runs/missing/events`, {
      headers: {
        Accept: "text/event-stream",
      },
    });

    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    await expect(stream.text()).resolves.toBe("");
  });
});

function ingest(
  baseUrl: string,
  event: AtomicFlowEvent,
  path = "/api/ingest/events",
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    body: JSON.stringify({
      event,
      project: {
        id: "project-id",
        name: "Runtime Project",
      },
      run: {
        prompt: "Review the CLI flow",
        sessionId: "session-1",
      },
    }),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  });
}

function atomicEvent(
  sequence: number,
  eventId: string,
  phase: AtomicFlowEvent["phase"],
): AtomicFlowEvent {
  return {
    atom: {
      key: "run",
      kind: "input",
      label: "Run",
      level: "runtime",
    },
    eventId,
    instance: {
      id: "run-instance",
    },
    occurredAt: `2026-08-01T00:00:0${sequence}.000Z`,
    phase,
    runId: "external-run",
    sequence,
  };
}

function createTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "yiku-flow-studio-"));
  directories.push(directory);
  return directory;
}
