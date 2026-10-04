import "@fontsource-variable/geist";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import { TooltipProvider } from "./components/ui/tooltip.js";
import "./index.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Root element is missing.");
}

createRoot(root).render(
  <StrictMode>
    <TooltipProvider>
      <App />
    </TooltipProvider>
  </StrictMode>,
);
