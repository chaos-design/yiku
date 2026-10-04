import type { StudioClientPlugin } from "@yiku/agent-studio/react";
import { App } from "../app.js";
import { AGENT_OBSERVATORY_MANIFEST } from "./manifest.js";

export interface AgentObservatoryClientOptions {
  readonly path?: `/${string}` | undefined;
}

export function agentObservatoryClientPlugin(
  options: AgentObservatoryClientOptions = {},
): StudioClientPlugin {
  return {
    manifest: AGENT_OBSERVATORY_MANIFEST,
    navigation: [
      {
        id: "atomic-flow",
        label: "Agent Observatory",
        order: 10,
        pageId: "atomic-flow",
      },
    ],
    pages: [
      {
        component: AtomicFlowPage,
        id: "atomic-flow",
        path: options.path ?? "/",
        title: "Agent Observatory",
      },
    ],
    themeTokens: {
      "--studio-accent": "#54d2d6",
      "--studio-background": "#090d0f",
      "--studio-border": "#263136",
      "--studio-foreground": "#dce7e9",
      "--studio-muted": "#73838a",
      "--studio-surface": "#111719",
    },
  };
}

function AtomicFlowPage() {
  return (
    <div className="atomic-flow-plugin-page">
      <App />
    </div>
  );
}
