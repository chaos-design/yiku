import { StudioShell } from "@yiku/agent-studio/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { agentObservatoryClientPlugin } from "./plugin/client-plugin.js";
import "./index.css";

const plugins = [agentObservatoryClientPlugin()];
const root = document.getElementById("root");
if (root === null) {
  throw new Error("Root element is missing.");
}

createRoot(root).render(
  <StrictMode>
    <StudioShell plugins={plugins} productName="Yiku Agent Studio" />
  </StrictMode>,
);
