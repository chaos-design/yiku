import { describe, expect, it, vi } from "vitest";
import { contextCommand } from "../../../src/slash-commands/builtin/context.js";

describe("/context", () => {
  it("returns structured calibrated usage", async () => {
    const contextUsage = {
      autocompactBufferTokens: 10,
      categories: [],
      contextWindow: 100,
      freeTokens: 70,
      model: "gpt-test",
      usedTokens: 20,
    };
    const context = {
      getContextSummary: vi.fn(() => "fallback"),
      getContextUsage: vi.fn(() => contextUsage),
    } as never;

    await expect(
      Promise.resolve(contextCommand.execute(context, { raw: "", values: [] })),
    ).resolves.toMatchObject({
      contextUsage,
      kind: "success",
    });
    expect(context.getContextSummary).not.toHaveBeenCalled();
  });

  it("falls back when metrics are unavailable and rejects arguments", async () => {
    const context = {
      getContextSummary: vi.fn(() => "unavailable"),
      getContextUsage: vi.fn(() => undefined),
    } as never;

    await expect(
      Promise.resolve(contextCommand.execute(context, { raw: "", values: [] })),
    ).resolves.toMatchObject({
      kind: "success",
      message: "unavailable",
    });
    await expect(
      Promise.resolve(contextCommand.execute(context, { raw: "extra", values: ["extra"] })),
    ).resolves.toMatchObject({
      kind: "error",
      message: "Usage: /context",
    });
  });
});
