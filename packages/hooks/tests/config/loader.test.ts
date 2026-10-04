import { describe, expect, it, vi } from "vitest";
import { HookConfigLoader } from "../../src/config/loader.js";
import { HookConfigError } from "../../src/errors.js";

describe("HookConfigLoader", () => {
  it("loads all sources in stable priority order", async () => {
    const files = new Map([
      ["/home/user/.yiku/settings.json", JSON.stringify(settings("user"))],
      ["/workspace/.yiku/settings.json", JSON.stringify(settings("project"))],
      ["/workspace/.yiku/settings.local.json", JSON.stringify(settings("local"))],
      ["/plugins/reviewer/hooks/hooks.json", JSON.stringify(settings("plugin"))],
    ]);
    const callback = vi.fn();
    const loader = new HookConfigLoader({
      components: [
        {
          componentId: "reviewer",
          content: `---
hooks:
  Stop:
    - hooks:
        - type: command
          command: echo skill
---`,
          path: "/skills/reviewer/SKILL.md",
          type: "skill",
        },
      ],
      localSettingsPath: "/workspace/.yiku/settings.local.json",
      managedSettings: settings("managed"),
      pluginSettingsPaths: ["/plugins/reviewer/hooks/hooks.json"],
      projectSettingsPath: "/workspace/.yiku/settings.json",
      readFile: async (path) => {
        const value = files.get(path);
        if (value === undefined) {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        }
        return value;
      },
      runtimeHooks: [
        {
          eventName: "Stop",
          handler: {
            callback,
            name: "runtime",
            type: "callback",
          },
        },
      ],
      userSettingsPath: "/home/user/.yiku/settings.json",
    });

    const documents = await loader.load();

    expect(documents.map((document) => document.source.type)).toEqual([
      "managed",
      "user",
      "project",
      "local",
      "plugin",
      "skill",
      "runtime",
    ]);
    expect(documents.at(-1)?.value).toMatchObject({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                callback,
                name: "runtime",
                type: "callback",
              },
            ],
          },
        ],
      },
    });
  });

  it("skips missing optional files", async () => {
    const loader = new HookConfigLoader({
      readFile: async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      userSettingsPath: "/missing/settings.json",
    });

    await expect(loader.load()).resolves.toEqual([]);
  });

  it("rejects relative paths, read errors, and invalid JSON", async () => {
    await expect(
      new HookConfigLoader({
        userSettingsPath: "relative/settings.json",
      }).load(),
    ).rejects.toThrow("must be absolute");
    await expect(
      new HookConfigLoader({
        readFile: async () => {
          throw new Error("denied");
        },
        userSettingsPath: "/settings.json",
      }).load(),
    ).rejects.toThrow(HookConfigError);
    await expect(
      new HookConfigLoader({
        readFile: async () => "{",
        userSettingsPath: "/settings.json",
      }).load(),
    ).rejects.toThrow("invalid JSON");
  });
});

function settings(command: string) {
  return {
    hooks: {
      Stop: [
        {
          hooks: [
            {
              command: `echo ${command}`,
              type: "command",
            },
          ],
        },
      ],
    },
  };
}
