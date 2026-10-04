import { afterEach, describe, expect, it, vi } from "vitest";
import { announceBrowserPresence, getRun, listRuns } from "../src/api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Studio API client", () => {
  it("announces an active Observatory browser page", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        status: "ok",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(announceBrowserPresence()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("/api/browser-presence", {
      method: "POST",
    });
  });

  it("lists and reads encoded runs", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("[]", {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ events: [], runId: "run/one" }), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(listRuns()).resolves.toEqual([]);
    await expect(getRun("run/one")).resolves.toMatchObject({ runId: "run/one" });
    expect(fetchMock).toHaveBeenLastCalledWith("/api/runs/run%2Fone", undefined);
  });

  it("uses server and status fallback error messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ message: "Missing" }), {
            headers: { "Content-Type": "application/json" },
            status: 404,
          }),
        )
        .mockResolvedValueOnce(
          new Response("{}", {
            headers: { "Content-Type": "application/json" },
            status: 500,
          }),
        ),
    );

    await expect(getRun("missing")).rejects.toThrow("Missing");
    await expect(listRuns()).rejects.toThrow("Request failed: 500");
  });
});
