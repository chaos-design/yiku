import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertStudioManifestCompatibility,
  loadStudioManifest,
  pluginRequest,
  StudioClientError,
} from "../../src/react/client.js";
import type { StudioPluginManifest } from "../../src/types.js";

const manifest = (id: string, version = "0.1.0"): StudioPluginManifest => ({
  capabilities: [],
  id,
  name: id,
  studioVersion: "0.1",
  version,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("assertStudioManifestCompatibility", () => {
  it("accepts matching plugins and rejects missing or mismatched plugins", () => {
    expect(() =>
      assertStudioManifestCompatibility([manifest("core")], [manifest("core")]),
    ).not.toThrow();
    expect(() => assertStudioManifestCompatibility([manifest("core")], [])).toThrow(
      "does not provide",
    );
    expect(() =>
      assertStudioManifestCompatibility([manifest("core")], [manifest("core", "0.2.0")]),
    ).toThrow("version does not match");
    expect(() =>
      assertStudioManifestCompatibility(
        [manifest("core")],
        [{ ...manifest("core"), studioVersion: "2" }],
      ),
    ).toThrow("version does not match");
  });
});

describe("pluginRequest", () => {
  it("requests a namespaced plugin route", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ value: 42 }), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(pluginRequest<{ value: number }>("workspace", "/settings")).resolves.toEqual({
      value: 42,
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/plugins/workspace/settings", undefined);
  });

  it("normalizes structured request errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ code: "NOPE", message: "No access" }), {
            headers: { "Content-Type": "application/json" },
            status: 403,
          }),
      ),
    );

    await expect(pluginRequest("workspace", "settings")).rejects.toEqual(
      expect.objectContaining<Partial<StudioClientError>>({
        code: "NOPE",
        message: "No access",
        status: 403,
      }),
    );
  });

  it("loads manifests and handles text success and fallback errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify([manifest("core")]), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          }),
      ),
    );
    await expect(loadStudioManifest()).resolves.toEqual([manifest("core")]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("plain", { status: 200 })),
    );
    await expect(pluginRequest<string>("workspace", "")).resolves.toBe("plain");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 })),
    );
    await expect(pluginRequest("workspace", "empty")).rejects.toMatchObject({
      code: "STUDIO_REQUEST_FAILED",
      message: "Request failed: 500",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Denied", { status: 403 })),
    );
    await expect(pluginRequest("workspace", "denied")).rejects.toMatchObject({
      message: "Denied",
    });
  });

  it("preserves JSON error details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              details: { enabled: true, nested: [1, null, "value"] },
            }),
            {
              headers: { "Content-Type": "application/json" },
              status: 422,
            },
          ),
      ),
    );

    await expect(pluginRequest("workspace", "details")).rejects.toMatchObject({
      code: "STUDIO_REQUEST_FAILED",
      details: { enabled: true, nested: [1, null, "value"] },
      message: "Request failed: 422",
    });
  });

  it.each([
    ["Invalid", "settings"],
    ["workspace", "../settings"],
  ])("rejects invalid plugin request %s %s", async (pluginId, path) => {
    await expect(pluginRequest(pluginId, path)).rejects.toBeInstanceOf(StudioClientError);
  });
});
