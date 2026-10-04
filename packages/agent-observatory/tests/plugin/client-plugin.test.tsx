import { createStudioClientRegistry } from "@yiku/agent-studio/react";
import { describe, expect, it } from "vitest";
import { agentObservatoryClientPlugin } from "../../src/plugin/client-plugin.js";
import { AGENT_OBSERVATORY_MANIFEST } from "../../src/plugin/manifest.js";

describe("agentObservatoryClientPlugin", () => {
  it("registers the existing Studio as a configurable page", () => {
    const plugin = agentObservatoryClientPlugin({ path: "/flow" });
    const registry = createStudioClientRegistry([plugin]);

    expect(plugin.manifest).toBe(AGENT_OBSERVATORY_MANIFEST);
    expect(registry.pages).toEqual([
      expect.objectContaining({
        id: "atomic-flow",
        path: "/flow",
        pluginId: "yiku.agent-observatory",
      }),
    ]);
    expect(registry.navigation).toEqual([
      expect.objectContaining({
        label: "Agent Observatory",
        pageId: "atomic-flow",
      }),
    ]);
    expect(registry.themeTokens["--studio-accent"]).toBe("#54d2d6");
  });
});
