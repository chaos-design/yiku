import { describe, expect, it, vi } from "vitest";
import { AtomicFlowError, AtomicFlowRun, AtomicStudioSink } from "../src/index.js";

describe("AtomicStudioSink", () => {
  it("normalizes the endpoint and publishes project-scoped events", async () => {
    const request = vi.fn(async () => new Response(null, { status: 202 }));
    const sink = new AtomicStudioSink({
      endpoint: "http://127.0.0.1:4318/",
      project: {
        id: " project-id ",
        name: " Runtime Project ",
      },
      request,
    });
    const event = createEvent();

    await sink.write(event);

    expect(request).toHaveBeenCalledWith(
      "http://127.0.0.1:4318/api/ingest/events",
      expect.objectContaining({
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      }),
    );
    const [, init] = request.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({
      event,
      project: {
        id: "project-id",
        name: "Runtime Project",
      },
    });
  });

  it("accepts the complete ingestion path and omits empty project metadata", async () => {
    const request = vi.fn(async () => new Response(null, { status: 200 }));
    const sink = new AtomicStudioSink({
      endpoint: "http://localhost:4318/api/ingest/events/?ignored=true",
      project: {
        id: " ",
      },
      request,
    });

    await sink.write(createEvent());

    expect(request.mock.calls[0]?.[0]).toBe("http://localhost:4318/api/ingest/events");
    const [, init] = request.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).not.toHaveProperty("project");
  });

  it("publishes normalized Run metadata once", async () => {
    const request = vi.fn(async () => new Response(null, { status: 202 }));
    const sink = new AtomicStudioSink({
      endpoint: "http://127.0.0.1:4318",
      request,
      run: {
        prompt: " Observe this run ",
        sessionId: " session-1 ",
      },
    });
    const event = createEvent();

    await sink.write(event);
    await sink.write(event);

    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({
      run: {
        prompt: "Observe this run",
        sessionId: "session-1",
      },
    });
    expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body))).not.toHaveProperty("run");
  });

  it("rejects non-loopback, secure, credentialed, and malformed endpoints", () => {
    for (const endpoint of [
      "https://127.0.0.1:4318",
      "http://example.com:4318",
      "http://user:pass@localhost:4318",
      "not-a-url",
    ]) {
      expect(() => new AtomicStudioSink({ endpoint })).toThrow(AtomicFlowError);
    }
  });

  it("reports structured response and network failures", async () => {
    const rejected = new AtomicStudioSink({
      endpoint: "http://localhost:4318",
      request: vi.fn(async () => Response.json({ message: "Sequence conflict." }, { status: 409 })),
    });
    const offline = new AtomicStudioSink({
      endpoint: "http://localhost:4318",
      request: vi.fn(async () => {
        throw new Error("offline");
      }),
    });

    await expect(rejected.write(createEvent())).rejects.toMatchObject({
      code: "ATOMIC_FLOW_SINK_FAILED",
      message: "Sequence conflict.",
    });
    await expect(offline.write(createEvent())).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: "offline",
      }),
      code: "ATOMIC_FLOW_SINK_FAILED",
    });
  });
});

function createEvent() {
  const flow = new AtomicFlowRun({
    clock: () => new Date("2026-08-01T00:00:00.000Z"),
    eventIdGenerator: () => "event-1",
    instanceIdGenerator: () => "instance-1",
    runId: "run-1",
  });
  return flow.start({
    atom: {
      key: "run",
      kind: "input",
      label: "Run",
      level: "runtime",
    },
  }).startEvent;
}
