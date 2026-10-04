import { request as httpsRequest, type RequestOptions } from "node:https";
import { HookError, HookExecutionError, HookTimeoutError } from "../errors.js";
import {
  type HookDnsResolver,
  type HookResolvedAddress,
  resolvePublicHookAddresses,
} from "../security/network.js";

export interface HookHttpTransportRequest {
  readonly body: Buffer;
  readonly deadline: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly maxBodyBytes: number;
  readonly maxHeaderBytes: number;
  readonly signal?: AbortSignal | undefined;
  readonly url: URL;
}

export interface HookHttpTransportResponse {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly statusCode: number;
}

export interface HookHttpTransport {
  request(input: HookHttpTransportRequest): Promise<HookHttpTransportResponse>;
}

export type HookHttpsRequester = (
  input: HookHttpTransportRequest,
  address: HookResolvedAddress,
) => Promise<HookHttpTransportResponse>;

export interface HttpsHookTransportOptions {
  readonly requestOne?: HookHttpsRequester | undefined;
  readonly resolver?: HookDnsResolver | undefined;
}

export class HttpsHookTransport implements HookHttpTransport {
  private readonly requestOne: HookHttpsRequester;
  private readonly resolver?: HookDnsResolver | undefined;

  public constructor(options: HttpsHookTransportOptions = {}) {
    this.requestOne = options.requestOne ?? requestPinnedAddress;
    this.resolver = options.resolver;
  }

  public async request(input: HookHttpTransportRequest): Promise<HookHttpTransportResponse> {
    const addresses = await resolvePublicHookAddresses(input.url.hostname, this.resolver);
    const address = addresses[0];

    if (address === undefined) {
      throw new HookExecutionError(
        "HOOK_EXECUTION_FAILED",
        "Hook HTTP target has no usable address.",
        { executorType: "http" },
      );
    }

    return this.requestOne(input, address);
  }
}

export function requestPinnedAddress(
  input: HookHttpTransportRequest,
  address: HookResolvedAddress,
  requestImpl: typeof httpsRequest = httpsRequest,
): Promise<HookHttpTransportResponse> {
  const remainingMs = input.deadline - Date.now();
  if (remainingMs <= 0) {
    return Promise.reject(httpTimeout());
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let bodyBytes = 0;
    const options: RequestOptions = {
      headers: input.headers,
      lookup: (_hostname, _options, callback) => {
        callback(null, address.address, address.family);
      },
      method: "POST",
      servername: input.url.hostname,
    };
    const request = requestImpl(input.url, options, (response) => {
      const headerBytes = Buffer.byteLength(response.rawHeaders.join("\r\n"), "utf8");
      if (headerBytes > input.maxHeaderBytes) {
        request.destroy(
          new HookExecutionError(
            "HOOK_EXECUTION_FAILED",
            "Hook HTTP response headers exceed the configured limit.",
            { executorType: "http" },
          ),
        );
        return;
      }

      response.on("data", (chunk: Buffer) => {
        bodyBytes += chunk.length;
        if (bodyBytes > input.maxBodyBytes) {
          request.destroy(
            new HookExecutionError(
              "HOOK_EXECUTION_FAILED",
              "Hook HTTP response body exceeds the configured limit.",
              { executorType: "http" },
            ),
          );
          return;
        }
        chunks.push(chunk);
      });
      response.once("end", () => {
        finish(() =>
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            headers: normalizeHeaders(response.headers),
            statusCode: response.statusCode ?? 0,
          }),
        );
      });
      response.once("error", onError);
    });
    const timeout = setTimeout(() => request.destroy(httpTimeout()), remainingMs);
    const onAbort = () =>
      request.destroy(
        new HookExecutionError("HOOK_ABORTED", "Hook HTTP request was aborted.", {
          cause: input.signal?.reason,
          executorType: "http",
          retryable: true,
        }),
      );
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onError = (error: Error) => {
      finish(() =>
        reject(
          error instanceof HookError
            ? error
            : new HookExecutionError("HOOK_EXECUTION_FAILED", "Hook HTTP request failed.", {
                cause: error,
                executorType: "http",
              }),
        ),
      );
    };

    request.once("error", onError);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted === true) {
      onAbort();
      return;
    }
    request.end(input.body);
  });
}

function normalizeHeaders(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(headers)
        .filter((entry): entry is [string, string | readonly string[]] => entry[1] !== undefined)
        .map(([name, value]) => [
          name.toLowerCase(),
          typeof value === "string" ? value : value.join(", "),
        ]),
    ),
  );
}

function httpTimeout(): HookTimeoutError {
  return new HookTimeoutError("HOOK_TIMEOUT", "Hook HTTP request timed out.", {
    executorType: "http",
    retryable: true,
  });
}
