import { describe, expect, it } from "vitest";
import { MemoryValidationError } from "../../src/errors.js";
import { PatternMemoryRedactor, redactMemoryContent } from "../../src/policy/redaction.js";

describe("redactMemoryContent", () => {
  it("masks built-in credential formats without exposing values", () => {
    const result = redactMemoryContent(
      [
        "Authorization: Bearer abc.def-123",
        "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz",
        "token=plain-secret",
        "github=ghp_abcdefghijklmnopqrstuvwxyz",
        "-----BEGIN PRIVATE KEY-----",
        "private material",
        "-----END PRIVATE KEY-----",
      ].join("\n"),
    );

    expect(result.content).not.toContain("abc.def-123");
    expect(result.content).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(result.content).not.toContain("plain-secret");
    expect(result.content).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(result.content).not.toContain("private material");
    expect(result.content).toContain("[REDACTED]");
    expect(result.redactors).toEqual(
      expect.arrayContaining([
        "bearer-token",
        "credential-assignment",
        "github-token",
        "openai-key",
        "private-key",
      ]),
    );
  });

  it("runs custom redactors after built-ins and reports only changed names", () => {
    const custom = new PatternMemoryRedactor("email", /user@example\.com/gu);

    expect(redactMemoryContent("contact user@example.com", [custom])).toEqual({
      content: "contact [REDACTED]",
      redactors: ["email"],
    });
    expect(redactMemoryContent("public content")).toEqual({
      content: "public content",
      redactors: [],
    });
  });

  it("fails closed when a custom redactor throws", () => {
    expect(() =>
      redactMemoryContent("content", [
        {
          name: "broken",
          redact() {
            throw new Error("failed");
          },
        },
      ]),
    ).toThrow(MemoryValidationError);
    expect(() =>
      redactMemoryContent("content", [
        {
          name: "broken",
          redact() {
            throw new Error("failed");
          },
        },
      ]),
    ).toThrow("broken");
  });
});
