import { describe, expect, it } from "vitest";
import {
  assertUniqueContributions,
  orderStudioPlugins,
  type StudioPluginError,
} from "../src/plugin-registry.js";
import type { StudioPluginManifest } from "../src/types.js";

const plugin = (id: string, requires: readonly string[] = []) => ({
  manifest: {
    capabilities: [],
    id,
    name: id,
    requires,
    studioVersion: "1",
    version: "1",
  } satisfies StudioPluginManifest,
});

describe("orderStudioPlugins", () => {
  it("orders dependencies before dependants while preserving unrelated order", () => {
    const result = orderStudioPlugins([
      plugin("feature", ["core"]),
      plugin("theme"),
      plugin("core"),
    ]);

    expect(result.map((entry) => entry.manifest.id)).toEqual(["core", "feature", "theme"]);
  });

  it.each([
    {
      code: "PLUGIN_DUPLICATE",
      plugins: [plugin("core"), plugin("core")],
    },
    {
      code: "PLUGIN_ID_INVALID",
      plugins: [plugin("Invalid")],
    },
    {
      code: "PLUGIN_MISSING",
      plugins: [plugin("feature", ["missing"])],
    },
    {
      code: "PLUGIN_CYCLE",
      plugins: [plugin("one", ["two"]), plugin("two", ["one"])],
    },
    {
      code: "PLUGIN_VERSION_UNSUPPORTED",
      plugins: [plugin("core")],
      studioVersion: "2",
    },
  ])("rejects $code", ({ code, plugins, studioVersion }) => {
    expect(() => orderStudioPlugins(plugins, studioVersion)).toThrowError(
      expect.objectContaining<Partial<StudioPluginError>>({ code }),
    );
  });
});

describe("assertUniqueContributions", () => {
  it("reports both owners of a duplicate contribution", () => {
    expect(() =>
      assertUniqueContributions("Page", [
        { id: "runs", pluginId: "one" },
        { id: "runs", pluginId: "two" },
      ]),
    ).toThrow('Page "runs" is contributed by both "one" and "two".');
  });
});
