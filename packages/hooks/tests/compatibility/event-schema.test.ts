import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HOOK_EVENT_SCHEMAS,
  hookEventSchema,
  jsonObjectSchema,
  jsonValueSchema,
  parseHookEvent,
} from "../../src/compatibility/event-schema.js";
import { HOOK_EVENT_NAMES, type HookEvent } from "../../src/types.js";

const validEvents = JSON.parse(
  readFileSync(new URL("./fixtures/events/valid.json", import.meta.url), "utf8"),
) as HookEvent[];

describe("hook event schema", () => {
  it("parses one fixture for every event", () => {
    expect(validEvents.map((event) => event.hook_event_name)).toEqual(HOOK_EVENT_NAMES);

    for (const event of validEvents) {
      expect(parseHookEvent(event)).toEqual(event);
      expect(HOOK_EVENT_SCHEMAS[event.hook_event_name].safeParse(event).success).toBe(true);
    }
  });

  it("rejects unknown fields for every event contract", () => {
    for (const event of validEvents) {
      expect(
        hookEventSchema.safeParse({
          ...event,
          unexpected_field: true,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects missing common fields and event-specific invalid values", () => {
    const prompt = validEvents.find((event) => event.hook_event_name === "UserPromptSubmit");
    const stop = validEvents.find((event) => event.hook_event_name === "StopFailure");

    expect(prompt).toBeDefined();
    expect(stop).toBeDefined();

    const { session_id: _sessionId, ...withoutSession } = prompt as HookEvent & {
      readonly session_id: string;
    };
    expect(hookEventSchema.safeParse(withoutSession).success).toBe(false);
    expect(
      hookEventSchema.safeParse({
        ...stop,
        error_type: "not-a-real-error",
      }).success,
    ).toBe(false);
  });

  it("accepts bounded JSON values and rejects non-JSON values", () => {
    expect(jsonValueSchema.parse({ nested: [true, null, 1, "text"] })).toEqual({
      nested: [true, null, 1, "text"],
    });
    expect(jsonObjectSchema.safeParse({ invalid: undefined }).success).toBe(false);
    expect(jsonValueSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
    expect(jsonValueSchema.safeParse(() => undefined).success).toBe(false);
  });
});
