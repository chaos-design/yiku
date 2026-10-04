import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type ConfiguredHookHandler,
  HOOK_HANDLER_SCHEMAS,
  hookHandlerSchema,
  parseHookHandler,
} from "../../src/compatibility/handler-schema.js";

const validHandlers = JSON.parse(
  readFileSync(new URL("./fixtures/handlers/valid.json", import.meta.url), "utf8"),
) as ConfiguredHookHandler[];

describe("hook handler schema", () => {
  it("parses every configured executor type", () => {
    expect(validHandlers.map((handler) => handler.type)).toEqual([
      "command",
      "http",
      "prompt",
      "agent",
      "mcp",
    ]);

    for (const handler of validHandlers) {
      expect(parseHookHandler(handler)).toEqual(handler);
      expect(HOOK_HANDLER_SCHEMAS[handler.type].safeParse(handler).success).toBe(true);
    }
  });

  it("rejects unknown fields and invalid common limits", () => {
    for (const handler of validHandlers) {
      expect(hookHandlerSchema.safeParse({ ...handler, unknown: true }).success).toBe(false);
      expect(hookHandlerSchema.safeParse({ ...handler, timeout: 0 }).success).toBe(false);
    }
  });

  it("enforces command and agent invariants", () => {
    expect(
      hookHandlerSchema.safeParse({
        asyncRewake: true,
        command: "pnpm test",
        type: "command",
      }).success,
    ).toBe(false);
    expect(
      hookHandlerSchema.safeParse({
        maxTurns: 51,
        prompt: "review",
        type: "agent",
      }).success,
    ).toBe(false);
  });

  it("rejects malformed HTTP and MCP targets", () => {
    expect(
      hookHandlerSchema.safeParse({
        type: "http",
        url: "not a url",
      }).success,
    ).toBe(false);
    expect(
      hookHandlerSchema.safeParse({
        server: "",
        tool: "evaluate",
        type: "mcp",
      }).success,
    ).toBe(false);
  });
});
