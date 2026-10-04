import { describe, expect, it } from "vitest";
import { ContextBudget } from "../../src/session/context-budget.js";

describe("ContextBudget", () => {
  const budget = new ContextBudget({
    compactAtContextRatio: 0.7,
    compactToContextRatio: 0.25,
    fallbackMaxCharacters: 32_000,
  });

  it("triggers from peak tokens and calculates the target summary size", () => {
    expect(
      budget.evaluate({
        contextWindow: 1_000,
        historyCharacters: 100,
        peakInputTokens: 700,
      }),
    ).toEqual({
      maxSummaryChars: 1_000,
      reason: "tokens",
      shouldCompact: true,
    });
  });

  it("uses the character fallback when token usage is unavailable", () => {
    expect(
      budget.evaluate({
        historyCharacters: 22_400,
      }),
    ).toEqual({
      maxSummaryChars: 8_000,
      reason: "characters",
      shouldCompact: true,
    });
  });

  it("does not compact below either threshold", () => {
    expect(
      budget.evaluate({
        contextWindow: 1_000,
        historyCharacters: 10_000,
        peakInputTokens: 699,
      }),
    ).toEqual({
      maxSummaryChars: 1_000,
      shouldCompact: false,
    });
  });

  it("validates ratios, fallback limits, and token inputs", () => {
    expect(
      () =>
        new ContextBudget({
          compactAtContextRatio: 1,
          compactToContextRatio: 0.25,
          fallbackMaxCharacters: 100,
        }),
    ).toThrow("compactAtContextRatio");
    expect(
      () =>
        new ContextBudget({
          compactAtContextRatio: 0.5,
          compactToContextRatio: 0.5,
          fallbackMaxCharacters: 100,
        }),
    ).toThrow("must be less");
    expect(
      () =>
        new ContextBudget({
          compactAtContextRatio: 0.7,
          compactToContextRatio: 0.25,
          fallbackMaxCharacters: 0,
        }),
    ).toThrow("fallbackMaxCharacters");
    expect(
      () =>
        new ContextBudget({
          charactersPerToken: 0,
          compactAtContextRatio: 0.7,
          compactToContextRatio: 0.25,
          fallbackMaxCharacters: 100,
        }),
    ).toThrow("charactersPerToken");
    expect(() =>
      budget.evaluate({
        contextWindow: 0,
        historyCharacters: 0,
        peakInputTokens: 1,
      }),
    ).toThrow("contextWindow");
  });
});
