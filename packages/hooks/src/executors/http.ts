import { parseHookHandlerOutput } from "../compatibility/output-schema.js";
import { HookExecutionError, HookProtocolError, HookSecurityError } from "../errors.js";
import { HookLimits } from "../security/limits.js";
import type {
  HookExecutionContext,
  HookExecutionResult,
  HookExecutor,
  HookHandler,
  HookHandlerOutput,
  HookInvocation,
} from "../types.js";
import {
  type HookHttpTransport,
  type HookHttpTransportResponse,
  HttpsHookTransport,
} from "./http-transport.js";

const ENV_REFERENCE_PATTERN = /\$([A-Za-z_][A-Za-z0-9_]*)/gu;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface HttpHookExecutorOptions {
  readonly clock?: (() => Date) | undefined;
  readonly limits?: HookLimits | undefined;
  readonly transport?: HookHttpTransport | undefined;
}

export class HttpHookExecutor implements HookExecutor {
  public readonly type = "http";
  private readonly clock: () => Date;
  private readonly limits: HookLimits;
  private readonly transport: HookHttpTransport;

  public constructor(options: HttpHookExecutorOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.limits = options.limits ?? new HookLimits();
    this.transport = options.transport ?? new HttpsHookTransport();
  }

  public async execute(
    invocation: HookInvocation,
    handler: HookHandler,
    context: HookExecutionContext,
  ): Promise<HookExecutionResult> {
    if (handler.type !== "http") {
      throw new HookExecutionError(
        "HOOK_EXECUTION_FAILED",
        "HTTP executor received a non-HTTP handler.",
        {
          executorType: this.type,
          hookId: invocation.hookId,
        },
      );
    }

    const startedAt = this.clock();
    const body = Buffer.from(JSON.stringify(invocation.event), "utf8");
    if (body.length > this.limits.maxInputBytes) {
      throw new HookExecutionError(
        "HOOK_EXECUTION_FAILED",
        `Hook HTTP input exceeds ${this.limits.maxInputBytes} bytes.`,
        {
          eventName: invocation.event.hook_event_name,
          executorType: this.type,
          hookId: invocation.hookId,
        },
      );
    }

    let url = validateUrl(handler.url);
    const originalOrigin = url.origin;
    const headers = resolveHeaders(handler.headers ?? {}, handler.allowedEnvVars ?? [], context);
    let response: HookHttpTransportResponse | undefined;

    for (let redirect = 0; redirect <= this.limits.maxRedirects; redirect += 1) {
      response = await this.transport.request({
        body,
        deadline: context.deadline,
        headers: {
          ...headers,
          "content-length": String(body.length),
          "content-type": "application/json",
        },
        maxBodyBytes: this.limits.maxOutputBytes,
        maxHeaderBytes: this.limits.maxOutputBytes,
        ...(context.signal !== undefined ? { signal: context.signal } : {}),
        url,
      });

      if (!REDIRECT_STATUSES.has(response.statusCode)) {
        break;
      }

      if (redirect === this.limits.maxRedirects) {
        throw new HookSecurityError(
          "HOOK_SECURITY_REJECTED",
          "Hook HTTP redirect limit exceeded.",
          {
            eventName: invocation.event.hook_event_name,
            executorType: this.type,
            hookId: invocation.hookId,
          },
        );
      }

      const location = response.headers.location;
      if (!location) {
        throw new HookProtocolError(
          "HOOK_PROTOCOL_INVALID",
          "Hook HTTP redirect response is missing Location.",
          {
            eventName: invocation.event.hook_event_name,
            executorType: this.type,
            hookId: invocation.hookId,
          },
        );
      }

      url = validateUrl(new URL(location, url).toString());
      if (url.origin !== originalOrigin) {
        throw new HookSecurityError(
          "HOOK_SECURITY_REJECTED",
          "Hook HTTP redirects must remain on the configured origin.",
          {
            eventName: invocation.event.hook_event_name,
            executorType: this.type,
            hookId: invocation.hookId,
          },
        );
      }
    }

    if (response === undefined || response.statusCode < 200 || response.statusCode >= 300) {
      throw new HookExecutionError(
        "HOOK_EXECUTION_FAILED",
        `Hook HTTP request failed with status ${response?.statusCode ?? 0}.`,
        {
          eventName: invocation.event.hook_event_name,
          executorType: this.type,
          hookId: invocation.hookId,
          retryable: (response?.statusCode ?? 0) >= 500,
        },
      );
    }

    const output = parseResponseBody(invocation, response.body);
    const endedAt = this.clock();
    return {
      durationMs: endedAt.getTime() - startedAt.getTime(),
      endedAt: endedAt.toISOString(),
      ...(output !== undefined ? { output } : {}),
      startedAt: startedAt.toISOString(),
      status: "success",
      stdout: response.body,
    };
  }
}

function resolveHeaders(
  configured: Readonly<Record<string, string>>,
  allowedEnvVars: readonly string[],
  context: HookExecutionContext,
): Readonly<Record<string, string>> {
  const allowed = new Set(allowedEnvVars);
  const headers: Record<string, string> = {};

  for (const [name, value] of Object.entries(configured)) {
    if (/[\r\n]/u.test(name) || /[\r\n]/u.test(value)) {
      throw new HookSecurityError(
        "HOOK_SECURITY_REJECTED",
        "Hook HTTP headers must not contain line breaks.",
        { executorType: "http" },
      );
    }

    headers[name.toLowerCase()] = value.replace(
      ENV_REFERENCE_PATTERN,
      (_reference, variable: string) => {
        if (!allowed.has(variable)) {
          throw new HookSecurityError(
            "HOOK_SECURITY_REJECTED",
            `Hook HTTP header references a non-allowlisted environment variable: ${variable}.`,
            { executorType: "http" },
          );
        }

        const resolved = context.environment[variable];
        if (resolved === undefined) {
          throw new HookExecutionError(
            "HOOK_EXECUTION_FAILED",
            `Hook HTTP environment variable is unavailable: ${variable}.`,
            { executorType: "http" },
          );
        }

        return resolved;
      },
    );
  }

  delete headers["content-length"];
  delete headers["content-type"];
  return Object.freeze(headers);
}

function validateUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new HookSecurityError("HOOK_SECURITY_REJECTED", "Hook HTTP URL is invalid.", {
      cause: error,
      executorType: "http",
    });
  }

  if (url.protocol !== "https:" || url.username || url.password) {
    throw new HookSecurityError(
      "HOOK_SECURITY_REJECTED",
      "Hook HTTP URL must use HTTPS without embedded credentials.",
      { executorType: "http" },
    );
  }

  return url;
}

function parseResponseBody(
  invocation: HookInvocation,
  body: string,
): HookHandlerOutput | undefined {
  const trimmed = body.trim();
  if (!trimmed) {
    return undefined;
  }

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    throw new HookProtocolError("HOOK_PROTOCOL_INVALID", "Hook HTTP response is not valid JSON.", {
      cause: error,
      eventName: invocation.event.hook_event_name,
      executorType: "http",
      hookId: invocation.hookId,
    });
  }

  return parseHookHandlerOutput(invocation.event.hook_event_name, value);
}
