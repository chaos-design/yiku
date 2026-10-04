import { describe, expect, it } from "vitest";
import { HookConfigReloader } from "../../src/config/reloader.js";
import { hookSource } from "../../src/config/source.js";

describe("HookConfigReloader", () => {
  it("atomically replaces a valid immutable snapshot", () => {
    const reloader = new HookConfigReloader();
    const initial = reloader.current();
    const compilation = reloader.reload([document("echo first")]);

    expect(initial.hooks).toEqual([]);
    expect(reloader.current()).toBe(compilation.snapshot);
    expect(reloader.current().hooks).toHaveLength(1);
  });

  it("keeps last-known-good when compilation fails", () => {
    const reloader = new HookConfigReloader(undefined, [document("echo first")]);
    const current = reloader.current();

    expect(() =>
      reloader.reload([
        {
          source: hookSource("project"),
          value: {
            hooks: {
              UnknownEvent: [],
            },
          },
        },
      ]),
    ).toThrow("Unsupported Hook event");
    expect(reloader.current()).toBe(current);
    expect(reloader.current().hooks[0]?.handler).toMatchObject({
      command: "echo first",
    });
  });
});

function document(command: string) {
  return {
    source: hookSource("project"),
    value: {
      hooks: {
        Stop: [
          {
            hooks: [{ command, type: "command" }],
          },
        ],
      },
    },
  };
}
