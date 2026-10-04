import type { JsonValue, StudioPluginManifest } from "../types.js";

export class StudioClientError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly details?: JsonValue | undefined,
  ) {
    super(message);
    this.name = "StudioClientError";
  }
}

export async function loadStudioManifest(): Promise<readonly StudioPluginManifest[]> {
  return request<readonly StudioPluginManifest[]>("/api/studio/manifest");
}

export function assertStudioManifestCompatibility(
  local: readonly StudioPluginManifest[],
  remote: readonly StudioPluginManifest[],
): void {
  const remoteById = new Map(remote.map((manifest) => [manifest.id, manifest]));
  for (const manifest of local) {
    const serverManifest = remoteById.get(manifest.id);
    if (serverManifest === undefined) {
      throw new StudioClientError(
        `Studio Server does not provide required plugin "${manifest.id}".`,
        "STUDIO_PLUGIN_MISSING",
        409,
      );
    }
    if (
      serverManifest.studioVersion !== manifest.studioVersion ||
      serverManifest.version !== manifest.version
    ) {
      throw new StudioClientError(
        `Studio plugin "${manifest.id}" version does not match the Server.`,
        "STUDIO_PLUGIN_VERSION_MISMATCH",
        409,
        {
          client: manifest.version,
          server: serverManifest.version,
        },
      );
    }
  }
}

export async function pluginRequest<T>(
  pluginId: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(pluginId)) {
    throw new StudioClientError("Plugin ID is invalid.", "STUDIO_PLUGIN_ID_INVALID", 400);
  }
  const relativePath = path.replace(/^\/+/u, "");
  if (relativePath.split("/").includes("..")) {
    throw new StudioClientError("Plugin path is invalid.", "STUDIO_PLUGIN_PATH_INVALID", 400);
  }
  return request<T>(`/api/plugins/${pluginId}/${relativePath}`, init);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const contentType = response.headers.get("content-type") ?? "";
  const value = contentType.includes("application/json")
    ? ((await response.json()) as unknown)
    : await response.text();
  if (!response.ok) {
    const error = readError(value, response.status);
    throw new StudioClientError(error.message, error.code, response.status, error.details);
  }
  return value as T;
}

function readError(
  value: unknown,
  status: number,
): { readonly code: string; readonly details?: JsonValue; readonly message: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      code: "STUDIO_REQUEST_FAILED",
      message: typeof value === "string" && value ? value : `Request failed: ${status}`,
    };
  }
  const record = value as Record<string, unknown>;
  return {
    code: typeof record.code === "string" ? record.code : "STUDIO_REQUEST_FAILED",
    ...(isJsonValue(record.details) ? { details: record.details } : {}),
    message:
      typeof record.message === "string" && record.message
        ? record.message
        : `Request failed: ${status}`,
  };
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return typeof value === "object" && value !== null && Object.values(value).every(isJsonValue);
}
