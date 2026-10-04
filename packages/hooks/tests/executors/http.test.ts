import { describe, expect, it } from "vitest";
import { HookExecutionError, HookProtocolError, HookSecurityError } from "../../src/errors.js";
import { HttpHookExecutor } from "../../src/executors/http.js";
import type {
  HookHttpTransport,
  HookHttpTransportRequest,
  HookHttpTransportResponse,
} from "../../src/executors/http-transport.js";
import { HookLimits } from "../../src/security/limits.js";
import type { HookInvocation, HttpHookHandler } from "../../src/types.js";

describe("HttpHookExecutor", () => {
  it("posts event JSON with allowlisted environment headers", async () => {
    const transport = new FakeTransport([response(200, '{"additionalContext":"remote context"}')]);
    const executor = new HttpHookExecutor({ transport });
    const invocation = httpInvocation({
      allowedEnvVars: ["HOOK_TOKEN"],
      headers: {
        Authorization: "Bearer $HOOK_TOKEN",
      },
      type: "http",
      url: "https://hooks.example.test/events",
    });

    await expect(
      executor.execute(invocation, invocation.handler, executionContext()),
    ).resolves.toMatchObject({
      output: { additionalContext: "remote context" },
      status: "success",
    });
    expect(transport.requests[0]).toMatchObject({
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      url: new URL("https://hooks.example.test/events"),
    });
    expect(JSON.parse(transport.requests[0]?.body.toString("utf8") ?? "")).toMatchObject({
      hook_event_name: "SessionStart",
    });
  });

  it("follows same-origin redirects and rejects cross-origin redirects", async () => {
    const sameOrigin = new FakeTransport([
      response(302, "", { location: "/next" }),
      response(200, "{}"),
    ]);
    const invocation = httpInvocation(defaultHandler());

    await new HttpHookExecutor({ transport: sameOrigin }).execute(
      invocation,
      invocation.handler,
      executionContext(),
    );
    expect(sameOrigin.requests.map((request) => request.url.pathname)).toEqual([
      "/events",
      "/next",
    ]);

    const crossOrigin = new FakeTransport([
      response(302, "", { location: "https://other.example.test/next" }),
    ]);
    await expect(
      new HttpHookExecutor({ transport: crossOrigin }).execute(
        invocation,
        invocation.handler,
        executionContext(),
      ),
    ).rejects.toBeInstanceOf(HookSecurityError);
  });

  it("rejects redirect loops, missing locations, and non-success responses", async () => {
    const invocation = httpInvocation(defaultHandler());
    const loop = new FakeTransport([
      response(302, "", { location: "/next" }),
      response(302, "", { location: "/events" }),
    ]);

    await expect(
      new HttpHookExecutor({
        limits: new HookLimits({ maxRedirects: 1 }),
        transport: loop,
      }).execute(invocation, invocation.handler, executionContext()),
    ).rejects.toThrow("redirect limit");
    await expect(
      new HttpHookExecutor({
        transport: new FakeTransport([response(302, "")]),
      }).execute(invocation, invocation.handler, executionContext()),
    ).rejects.toBeInstanceOf(HookProtocolError);
    await expect(
      new HttpHookExecutor({
        transport: new FakeTransport([response(503, "{}")]),
      }).execute(invocation, invocation.handler, executionContext()),
    ).rejects.toMatchObject({
      code: "HOOK_EXECUTION_FAILED",
      retryable: true,
    });
  });

  it("rejects unsafe URLs, headers, environment references, and response JSON", async () => {
    const transport = new FakeTransport([response(200, "{")]);

    for (const url of [
      "http://hooks.example.test",
      "https://user:password@hooks.example.test",
      "not a url",
    ]) {
      const invocation = httpInvocation({ ...defaultHandler(), url });
      await expect(
        new HttpHookExecutor({ transport }).execute(
          invocation,
          invocation.handler,
          executionContext(),
        ),
      ).rejects.toBeInstanceOf(HookSecurityError);
    }

    const notAllowed = httpInvocation({
      ...defaultHandler(),
      headers: { Authorization: "Bearer $HOOK_TOKEN" },
    });
    await expect(
      new HttpHookExecutor({ transport }).execute(
        notAllowed,
        notAllowed.handler,
        executionContext(),
      ),
    ).rejects.toThrow("non-allowlisted");

    const invalidJson = httpInvocation(defaultHandler());
    await expect(
      new HttpHookExecutor({ transport }).execute(
        invalidJson,
        invalidJson.handler,
        executionContext(),
      ),
    ).rejects.toBeInstanceOf(HookProtocolError);
  });

  it("rejects oversized input and the wrong handler type", async () => {
    const invocation = httpInvocation(defaultHandler());
    const limited = new HttpHookExecutor({
      limits: new HookLimits({ maxInputBytes: 10 }),
      transport: new FakeTransport([]),
    });

    await expect(
      limited.execute(invocation, invocation.handler, executionContext()),
    ).rejects.toBeInstanceOf(HookExecutionError);
    await expect(
      new HttpHookExecutor({ transport: new FakeTransport([]) }).execute(
        invocation,
        { prompt: "wrong", type: "prompt" },
        executionContext(),
      ),
    ).rejects.toThrow("non-HTTP");
  });
});

class FakeTransport implements HookHttpTransport {
  public readonly requests: HookHttpTransportRequest[] = [];

  public constructor(private readonly responses: HookHttpTransportResponse[]) {}

  public async request(input: HookHttpTransportRequest): Promise<HookHttpTransportResponse> {
    this.requests.push(input);
    const response = this.responses.shift();
    if (response === undefined) {
      throw new Error("No fake HTTP response.");
    }
    return response;
  }
}

function response(
  statusCode: number,
  body: string,
  headers: Readonly<Record<string, string>> = {},
): HookHttpTransportResponse {
  return { body, headers, statusCode };
}

function defaultHandler(): HttpHookHandler {
  return {
    type: "http",
    url: "https://hooks.example.test/events",
  };
}

function httpInvocation(handler: HttpHookHandler): HookInvocation {
  return {
    event: {
      cwd: "/workspace",
      hook_event_name: "SessionStart",
      permission_mode: "default",
      session_id: "session-1",
      source: "startup",
      transcript_path: "/tmp/transcript.jsonl",
    },
    handler,
    hookId: "hook-http",
    invocationId: "invocation-http",
    source: {
      priority: 500,
      type: "project",
    },
  };
}

function executionContext() {
  return {
    deadline: Date.now() + 5_000,
    depth: 0,
    environment: {
      HOOK_TOKEN: "secret",
    },
  };
}
