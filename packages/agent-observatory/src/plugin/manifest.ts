import type { StudioPluginManifest } from "@yiku/agent-studio";

export const AGENT_OBSERVATORY_PLUGIN_ID = "yiku.agent-observatory";

export const AGENT_OBSERVATORY_MANIFEST: StudioPluginManifest = {
  capabilities: ["events.atomic-flow", "graph.atomic-flow", "runs.history", "runs.replay"],
  id: AGENT_OBSERVATORY_PLUGIN_ID,
  name: "Yiku Agent Observatory",
  studioVersion: "0.1",
  version: "0.1.0",
};
