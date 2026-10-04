import { EventEmitter } from "node:events";
import type { request as httpsRequest } from "node:https";
import { describe, expect, it, vi } from "vitest";
import { HookExecutionError, HookSecurityError, HookTimeoutError } from "../../src/errors.js";
import {
  type HookHttpTransportRequest,
  HttpsHookTransport,
  requestPinnedAddress,
} from "../../src/executors/http-transport.js";
import type { HookResolvedAddress } from "../../src/security/network.js";

describe("HttpsHookTransport", () => {
  it("pins a validated DNS address for the request", async () => {
    const requestOne = vi.fn(async () => ({
      body: "{}",
      headers: {},
      statusCode: 200,
    }));
    const transport = new HttpsHookTransport({
      requestOne,
      resolver: async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "1.1.1.1", family: 4 },
      ],
    });
    const input = requestInput();

    await expect(transport.request(input)).resolves.toMatchObject({ statusCode: 200 });
    expect(requestOne).toHaveBeenCalledWith(input, {
      address: "8.8.8.8",
      family: 4,
    });
  });

  it("rejects mixed or private DNS before opening a request", async () => {
    const requestOne = vi.fn();
    const transport = new HttpsHookTransport({
      requestOne,
      resolver: async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    });

    await expect(transport.request(requestInput())).rejects.toBeInstanceOf(HookSecurityError);
    expect(requestOne).not.toHaveBeenCalled();
  });

  it("honors an expired deadline before opening a socket", async () => {
    const transport = new HttpsHookTransport({
      resolver: async () => [{ address: "8.8.8.8", family: 4 }],
    });

    await expect(
      transport.request({
        ...requestInput(),
        deadline: Date.now() - 1,
      }),
    ).rejects.toBeInstanceOf(HookTimeoutError);
  });

  it("normalizes successful pinned responses and response headers", async () => {
    await expect(
      requestPinnedAddress(
        requestInput(),
        publicAddress(),
        fakeHttpsRequest({
          body: [Buffer.from("{"), Buffer.from("}")],
          headers: {
            "x-list": ["one", "two"],
            "x-missing": undefined,
            "x-value": "value",
          },
          rawHeaders: ["X-Value", "value"],
        }),
      ),
    ).resolves.toEqual({
      body: "{}",
      headers: {
        "x-list": "one, two",
        "x-value": "value",
      },
      statusCode: 0,
    });
  });

  it("enforces pinned response header and body limits", async () => {
    await expect(
      requestPinnedAddress(
        { ...requestInput(), maxHeaderBytes: 1 },
        publicAddress(),
        fakeHttpsRequest({ rawHeaders: ["X-Large", "value"] }),
      ),
    ).rejects.toThrow("headers exceed");
    await expect(
      requestPinnedAddress(
        { ...requestInput(), maxBodyBytes: 1 },
        publicAddress(),
        fakeHttpsRequest({ body: [Buffer.from("large")] }),
      ),
    ).rejects.toThrow("body exceeds");
  });

  it("maps response errors, request errors, abort, and timeout", async () => {
    await expect(
      requestPinnedAddress(
        requestInput(),
        publicAddress(),
        fakeHttpsRequest({ responseError: new Error("response failed") }),
      ),
    ).rejects.toThrow("Hook HTTP request failed");
    await expect(
      requestPinnedAddress(
        requestInput(),
        publicAddress(),
        fakeHttpsRequest({ requestError: new Error("socket failed") }),
      ),
    ).rejects.toThrow("Hook HTTP request failed");
    await expect(
      requestPinnedAddress(
        requestInput(),
        publicAddress(),
        fakeHttpsRequest({
          requestError: new HookExecutionError("HOOK_EXECUTION_FAILED", "typed failure"),
        }),
      ),
    ).rejects.toThrow("typed failure");

    const controller = new AbortController();
    controller.abort("canceled");
    await expect(
      requestPinnedAddress(
        { ...requestInput(), signal: controller.signal },
        publicAddress(),
        fakeHttpsRequest({}),
      ),
    ).rejects.toMatchObject({ code: "HOOK_ABORTED" });
    await expect(
      requestPinnedAddress(
        { ...requestInput(), deadline: Date.now() + 5 },
        publicAddress(),
        fakeHttpsRequest({}),
      ),
    ).rejects.toBeInstanceOf(HookTimeoutError);
  });
});

function requestInput(): HookHttpTransportRequest {
  return {
    body: Buffer.from("{}"),
    deadline: Date.now() + 1_000,
    headers: {
      "content-type": "application/json",
    },
    maxBodyBytes: 1_024,
    maxHeaderBytes: 1_024,
    url: new URL("https://hooks.example.test/events"),
  };
}

function publicAddress(): HookResolvedAddress {
  return { address: "8.8.8.8", family: 4 };
}

interface FakeResponse {
  readonly body?: readonly Buffer[] | undefined;
  readonly headers?: Readonly<Record<string, string | readonly string[] | undefined>> | undefined;
  readonly rawHeaders?: readonly string[] | undefined;
  readonly requestError?: Error | undefined;
  readonly responseError?: Error | undefined;
}

function fakeHttpsRequest(scenario: FakeResponse): typeof httpsRequest {
  return ((_url: unknown, _options: unknown, callback: (response: EventEmitter) => void) => {
    let destroyed = false;
    const request = new EventEmitter() as EventEmitter & {
      destroy(error: Error): void;
      end(body: Buffer): void;
    };
    request.destroy = (error) => {
      destroyed = true;
      queueMicrotask(() => request.emit("error", error));
    };
    request.end = () => {
      if (scenario.requestError !== undefined) {
        queueMicrotask(() => request.emit("error", scenario.requestError));
        return;
      }
      if (
        scenario.body === undefined &&
        scenario.headers === undefined &&
        scenario.rawHeaders === undefined &&
        scenario.responseError === undefined
      ) {
        return;
      }

      const response = new EventEmitter() as EventEmitter & {
        headers: Readonly<Record<string, string | readonly string[] | undefined>>;
        rawHeaders: readonly string[];
        statusCode?: number | undefined;
      };
      response.headers = scenario.headers ?? {};
      response.rawHeaders = scenario.rawHeaders ?? [];
      callback(response);
      queueMicrotask(() => {
        for (const chunk of scenario.body ?? []) {
          response.emit("data", chunk);
          if (destroyed) {
            return;
          }
        }
        if (scenario.responseError !== undefined) {
          response.emit("error", scenario.responseError);
        } else {
          response.emit("end");
        }
      });
    };
    return request;
  }) as unknown as typeof httpsRequest;
}
