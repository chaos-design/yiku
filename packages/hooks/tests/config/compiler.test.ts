import { describe, expect, it, vi } from "vitest";
import { HookConfigCompiler } from "../../src/config/compiler.js";
import { hookSource } from "../../src/config/source.js";
import { HookConfigError } from "../../src/errors.js";

describe("HookConfigCompiler", () => {
  it("compiles stable hooks and matches event fields and conditions", () => {
    const compiler = new HookConfigCompiler();
    const document = {
      source: hookSource("project", { path: "/workspace/.yiku/settings.json" }),
      value: {
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  command: "node guard.mjs",
                  if: "Bash(git *)",
                  type: "command",
                },
              ],
              matcher: "Bash",
            },
          ],
        },
      },
    } as const;

    const first = compiler.compile([document]).snapshot;
    const second = compiler.compile([document]).snapshot;

    expect(first.version).toBe(second.version);
    expect(first.hooks[0]?.hookId).toBe(second.hooks[0]?.hookId);
    expect(first.matches(preToolEvent("Bash", "git status"))).toHaveLength(1);
    expect(first.matches(preToolEvent("Bash", "pnpm test"))).toHaveLength(0);
    expect(first.matches(preToolEvent("Edit", "git status"))).toHaveLength(0);
  });

  it("orders sources by authority without overriding matching hooks", () => {
    const compiler = new HookConfigCompiler();
    const compilation = compiler.compile([
      document("runtime", "echo runtime"),
      document("project", "echo project"),
      document("managed", "echo managed"),
    ]);

    expect(compilation.snapshot.hooks.map((hook) => hook.source.type)).toEqual([
      "managed",
      "project",
      "runtime",
    ]);
    expect(compilation.snapshot.forEvent("Stop")).toHaveLength(3);
  });

  it("ignores unsupported matchers with an explicit diagnostic", () => {
    const compilation = new HookConfigCompiler().compile([
      {
        source: hookSource("project"),
        value: {
          hooks: {
            Stop: [
              {
                hooks: [{ command: "echo done", type: "command" }],
                matcher: "ignored",
              },
            ],
          },
        },
      },
    ]);

    expect(compilation.diagnostics).toEqual([
      expect.objectContaining({
        code: "HOOK_MATCHER_IGNORED",
        severity: "warning",
      }),
    ]);
    expect(compilation.snapshot.matches(stopEvent())).toHaveLength(1);
  });

  it("supports runtime callback registrations", () => {
    const callback = vi.fn();
    const compilation = new HookConfigCompiler().compile([
      {
        source: hookSource("runtime"),
        value: {
          hooks: {
            Stop: [
              {
                hooks: [{ callback, name: "runtime", type: "callback" }],
              },
            ],
          },
        },
      },
    ]);

    expect(compilation.snapshot.hooks[0]?.handler).toMatchObject({
      callback,
      name: "runtime",
      type: "callback",
    });
  });

  it("rejects unknown events, fields, handlers, and malformed roots", () => {
    const compiler = new HookConfigCompiler();

    expect(() => compiler.compile([{ source: hookSource("project"), value: [] }])).toThrow(
      HookConfigError,
    );
    expect(() =>
      compiler.compile([
        {
          source: hookSource("project"),
          value: { hooks: { UnknownEvent: [] } },
        },
      ]),
    ).toThrow("Unsupported Hook event");
    expect(() =>
      compiler.compile([
        {
          source: hookSource("project"),
          value: {
            hooks: {
              Stop: [{ hooks: [], unknown: true }],
            },
          },
        },
      ]),
    ).toThrow("Unknown Hook matcher group field");
    expect(() =>
      compiler.compile([
        {
          source: hookSource("project"),
          value: {
            hooks: {
              Stop: [{ hooks: [{ type: "callback" }] }],
            },
          },
        },
      ]),
    ).toThrow("is invalid");
  });

  it("freezes snapshots, hooks, handlers, and diagnostics", () => {
    const compilation = new HookConfigCompiler().compile([document("project", "echo done")]);
    const hook = compilation.snapshot.hooks[0];

    expect(Object.isFrozen(compilation.snapshot)).toBe(true);
    expect(Object.isFrozen(compilation.snapshot.hooks)).toBe(true);
    expect(Object.isFrozen(compilation.snapshot.diagnostics)).toBe(true);
    expect(Object.isFrozen(hook)).toBe(true);
    expect(Object.isFrozen(hook?.handler)).toBe(true);
  });
});

function document(type: "managed" | "project" | "runtime", command: string) {
  return {
    source: hookSource(type),
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

function preToolEvent(toolName: string, command: string) {
  return {
    cwd: "/workspace",
    hook_event_name: "PreToolUse",
    permission_mode: "default",
    session_id: "session-1",
    tool_input: { command },
    tool_name: toolName,
    tool_use_id: "tool-1",
    transcript_path: "/tmp/transcript.jsonl",
  } as const;
}

function stopEvent() {
  return {
    cwd: "/workspace",
    hook_event_name: "Stop",
    permission_mode: "default",
    session_id: "session-1",
    stop_hook_active: false,
    transcript_path: "/tmp/transcript.jsonl",
  } as const;
}
