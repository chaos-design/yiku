import {
  pluginRequest,
  type StudioClientPlugin,
  type StudioEventRendererProps,
  StudioNavigationDrawer,
} from "@yiku/agent-studio/react";
import { useEffect, useState } from "react";

type WorkspaceTab = "memories" | "prompts" | "settings";

interface WorkspaceItem {
  readonly detail?: string | undefined;
  readonly key: string;
  readonly label: string;
  readonly source?: string | undefined;
  readonly value?: string | undefined;
}

interface WorkspaceSnapshot {
  readonly memories: readonly WorkspaceItem[];
  readonly prompts: readonly WorkspaceItem[];
  readonly settings: readonly WorkspaceItem[];
}

const TABS: readonly { readonly id: WorkspaceTab; readonly label: string }[] = [
  { id: "settings", label: "Settings" },
  { id: "memories", label: "Memories" },
  { id: "prompts", label: "Prompts" },
];

const WORKSPACE_MANIFEST = {
  capabilities: [
    "pages.workspace",
    "resources.settings",
    "resources.memories",
    "resources.prompts",
  ],
  id: "yiku.workspace",
  name: "Workspace Capabilities",
  requires: ["yiku.agent-observatory"],
  studioVersion: "0.1",
  version: "0.1.0",
} as const;

export function workspaceClientPlugin(): StudioClientPlugin {
  return {
    eventRenderers: [
      {
        component: WorkspaceEvent,
        id: "workspace-event",
        matches: (event) => "workspace" in event,
      },
    ],
    manifest: WORKSPACE_MANIFEST,
    navigation: [
      {
        id: "workspace",
        label: "Workspace",
        order: 20,
        pageId: "workspace",
      },
    ],
    pages: [
      {
        component: WorkspacePage,
        id: "workspace",
        path: "/workspace",
        title: "Workspace",
      },
    ],
    slots: [
      {
        component: WorkspaceStatus,
        id: "workspace-status",
        slot: "header.actions",
      },
    ],
    themeTokens: {
      "--studio-accent": "#2dd4bf",
    },
  };
}

function WorkspacePage() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("settings");
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>();
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void pluginRequest<WorkspaceSnapshot>("yiku.workspace", "snapshot").then(
      (value) => {
        if (active) {
          setSnapshot(value);
        }
      },
      (cause: unknown) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const items = snapshot?.[activeTab] ?? [];
  return (
    <section className="workspace-page">
      <header className="workspace-page-header">
        <div>
          <span>COMPILE-TIME EXTENSION EXAMPLE</span>
          <div className="workspace-title-row">
            <h1>Workspace capabilities</h1>
            <StudioNavigationDrawer />
          </div>
        </div>
        <p>
          This page, its navigation entry, header slot, theme token and API are registered by one
          plugin without changing the Studio core.
        </p>
      </header>

      <div className="workspace-tabs" role="tablist">
        {TABS.map((tab) => (
          <button
            aria-selected={activeTab === tab.id}
            className={activeTab === tab.id ? "is-active" : ""}
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            role="tab"
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>

      {error ? <div className="workspace-error">{error}</div> : null}
      <div className="workspace-resource-grid">
        {items.map((item, index) => (
          <article key={item.key}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <div>
              <strong>{item.label}</strong>
              <code>{item.key}</code>
            </div>
            <p>{item.value ?? item.detail ?? item.source}</p>
          </article>
        ))}
        {snapshot === undefined && !error ? (
          <p className="workspace-loading">Loading API...</p>
        ) : null}
      </div>
    </section>
  );
}

function WorkspaceStatus() {
  return (
    <div className="workspace-plugin-status">
      <span />2 COMPILED PLUGINS
    </div>
  );
}

function WorkspaceEvent({ event }: StudioEventRendererProps) {
  return (
    <pre className="workspace-event-renderer">
      {JSON.stringify({ plugin: "yiku.workspace", event }, null, 2)}
    </pre>
  );
}
