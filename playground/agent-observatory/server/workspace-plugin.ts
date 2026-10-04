import { type StudioServerPlugin, studioManifest } from "@yiku/agent-studio/server";

export const WORKSPACE_SERVER_MANIFEST = {
  ...studioManifest("yiku.workspace", "Workspace Capabilities", [
    "pages.workspace",
    "resources.settings",
    "resources.memories",
    "resources.prompts",
  ]),
  requires: ["yiku.agent-observatory"],
};

export function workspaceServerPlugin(): StudioServerPlugin {
  return {
    manifest: WORKSPACE_SERVER_MANIFEST,
    routes: [
      {
        handle: () => ({
          body: {
            memories: [
              {
                detail: "Ephemeral context for the active Agent session.",
                key: "working",
                label: "Working memory",
              },
              {
                detail: "Long-lived facts projected by a Memory plugin.",
                key: "semantic",
                label: "Semantic memory",
              },
            ],
            prompts: [
              {
                key: "agent.system",
                label: "Agent system prompt",
                source: "packages/agents/*/src/prompts",
              },
              {
                key: "session.compaction",
                label: "Session compaction prompt",
                source: "packages/agent-orchestrator/src/prompts",
              },
            ],
            settings: [
              { key: "mode", label: "Runtime mode", value: "Local observer" },
              {
                key: "storage",
                label: "Run storage",
                value: "~/.yiku/workspaces/yiku_<parent>_<workspace>/logs/runs",
              },
              { key: "plugins", label: "Plugin loading", value: "Compile-time TypeScript" },
            ],
          },
        }),
        id: "workspace-snapshot",
        method: "GET",
        path: "/snapshot",
      },
    ],
  };
}
