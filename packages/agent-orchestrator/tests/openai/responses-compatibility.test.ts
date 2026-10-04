import { OpenAIResponsesModel } from "@openai/agents";
import { describe, expect, it } from "vitest";
import {
  CompatibleOpenAIProvider,
  installResponsesCompatibility,
  normalizeResponseOutputItems,
} from "../../src/openai/responses-compatibility.js";

interface ResponsesModelInternals {
  _convertResponseOutputItems: (items: unknown) => unknown;
}

describe("OpenAI Responses compatibility", () => {
  it("installs compatibility on models created by the default provider", async () => {
    const provider = new CompatibleOpenAIProvider({ apiKey: "test-key" });
    const model = await provider.getModel("test-model");

    expect(model).toBeInstanceOf(OpenAIResponsesModel);
    expect(
      (model as unknown as ResponsesModelInternals)._convertResponseOutputItems([
        { id: "reasoning-1", type: "reasoning" },
      ]),
    ).toEqual([
      expect.objectContaining({
        content: [],
        id: "reasoning-1",
        type: "reasoning",
      }),
    ]);
  });

  it("adds an empty summary only to malformed reasoning items", () => {
    const message = {
      content: [],
      id: "message-1",
      role: "assistant",
      status: "completed",
      type: "message",
    };
    const input = [
      { id: "reasoning-1", type: "reasoning" },
      { id: "reasoning-2", summary: null, type: "reasoning" },
      message,
    ];

    expect(normalizeResponseOutputItems(input)).toEqual([
      { id: "reasoning-1", summary: [], type: "reasoning" },
      { id: "reasoning-2", summary: [], type: "reasoning" },
      message,
    ]);
    expect(input[0]).not.toHaveProperty("summary");
  });

  it("preserves valid output arrays and unrelated malformed input", () => {
    const valid = [
      {
        id: "reasoning-1",
        summary: [{ text: "summary", type: "summary_text" }],
        type: "reasoning",
      },
      { id: "message-1", type: "message" },
    ];
    const invalid = { output: "not-an-array" };

    expect(normalizeResponseOutputItems(valid)).toBe(valid);
    expect(normalizeResponseOutputItems(invalid)).toBe(invalid);
  });

  it("preserves primitive and null output items", () => {
    const items = [null, "text", 42];

    expect(normalizeResponseOutputItems(items)).toBe(items);
  });

  it("does not wrap non-Responses models", () => {
    const model = {
      getResponse: async () => {
        throw new Error("not called");
      },
      getStreamedResponse: async function* () {
        yield* [];
      },
    };

    expect(installResponsesCompatibility(model)).toBe(model);
  });

  it("wraps a Responses model once and completes SDK conversion", () => {
    const model = new OpenAIResponsesModel({} as never, "test-model");
    const installed = installResponsesCompatibility(model);
    const convert = (installed as unknown as ResponsesModelInternals)._convertResponseOutputItems;
    const installedAgain = installResponsesCompatibility(model);

    expect(installed).toBe(model);
    expect(installedAgain).toBe(model);
    expect((installedAgain as unknown as ResponsesModelInternals)._convertResponseOutputItems).toBe(
      convert,
    );
    expect(convert([{ id: "reasoning-1", type: "reasoning" }])).toEqual([
      expect.objectContaining({
        content: [],
        id: "reasoning-1",
        type: "reasoning",
      }),
    ]);
  });

  it("continues to propagate unrelated converter failures", () => {
    const model = new OpenAIResponsesModel({} as never, "test-model");
    const failure = new Error("converter failed");
    Object.defineProperty(model, "_convertResponseOutputItems", {
      configurable: true,
      value: () => {
        throw failure;
      },
      writable: true,
    });
    installResponsesCompatibility(model);

    expect(() =>
      (model as unknown as ResponsesModelInternals)._convertResponseOutputItems([]),
    ).toThrow(failure);
  });

  it("leaves a Responses model unchanged when the SDK converter is unavailable", () => {
    const model = new OpenAIResponsesModel({} as never, "test-model");
    Object.defineProperty(model, "_convertResponseOutputItems", {
      configurable: true,
      value: undefined,
      writable: true,
    });

    expect(installResponsesCompatibility(model)).toBe(model);
    expect(
      (model as unknown as ResponsesModelInternals)._convertResponseOutputItems,
    ).toBeUndefined();
  });
});
