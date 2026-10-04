import type { JsonValue } from "@yiku/agent-studio";

export function compactJson(
  value: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, JsonValue>> {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

export function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
