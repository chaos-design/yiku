import { agentObservatoryClientPlugin } from "@yiku/agent-observatory/plugin/react";
import "@yiku/agent-observatory/styles.css";
import { StudioShell } from "@yiku/agent-studio/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { workspaceClientPlugin } from "./workspace-plugin.js";
import "./playground.css";

const plugins = [agentObservatoryClientPlugin({ path: "/" }), workspaceClientPlugin()];

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Root element is missing.");
}

createRoot(root).render(
  <StrictMode>
    <StudioShell plugins={plugins} productName="Yiku Agent Studio" />
  </StrictMode>,
);
