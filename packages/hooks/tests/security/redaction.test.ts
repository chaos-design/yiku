import { describe, expect, it } from "vitest";
import { HookSecurityError } from "../../src/errors.js";
import { HookRedactor, PatternHookRedactionRule } from "../../src/security/redaction.js";

describe("HookRedactor", () => {
  it("redacts built-in credential patterns", () => {
    const redactor = new HookRedactor();
    const value = redactor.redactText(
      "Authorization: Bearer abc.def-123 token=secret-value sk-1234567890abcdefghijkl",
    );

    expect(value).not.toContain("abc.def-123");
    expect(value).not.toContain("secret-value");
    expect(value).not.toContain("sk-1234567890abcdefghijkl");
    expect(value).toContain("[REDACTED]");
  });

  it("redacts sensitive JSON keys and nested values without mutation", () => {
    const redactor = new HookRedactor();
    const input = {
      authorization: "Bearer secret",
      nested: {
        message: "token=hidden",
        safe: "visible",
      },
    } as const;

    expect(redactor.redactJson(input)).toEqual({
      authorization: "[REDACTED]",
      nested: {
        message: "[REDACTED]",
        safe: "visible",
      },
    });
    expect(input.authorization).toBe("Bearer secret");
  });

  it("supports custom rules and converts failures to security errors", () => {
    const custom = new PatternHookRedactionRule("email", /user@example\.com/gu);
    expect(new HookRedactor([custom]).redactText("contact user@example.com")).toBe(
      "contact [REDACTED]",
    );

    expect(() =>
      new HookRedactor([
        {
          name: "broken",
          redact() {
            throw new Error("raw failure");
          },
        },
      ]).redactText("value"),
    ).toThrow(HookSecurityError);
  });
});
