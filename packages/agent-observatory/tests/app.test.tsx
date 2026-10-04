import { readFileSync } from "node:fs";
import { type StudioClientPlugin, StudioProvider } from "@yiku/agent-studio/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { agentObservatoryClientPlugin } from "../src/plugin/client-plugin.js";

const styles = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");

describe("App observer mode", () => {
  it("keeps observation controls without rendering a centered empty-state overlay", () => {
    const markup = renderToStaticMarkup(<App />);

    expect(markup).toContain("AGENT EVENT STREAM");
    expect(markup).toContain("Yiku Agent Observatory");
    expect(markup).toContain("Waiting for a Yiku CLI run");
    expect(markup).toContain("Guide");
    expect(markup).toContain('aria-label="Show topology view"');
    expect(markup).toContain('aria-label="Show trajectory view"');
    expect(markup).toContain('aria-label="Locate current trajectory step"');
    expect(markup).toContain('aria-controls="flow-guide-drawer"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('role="dialog"');
    expect(markup).toContain('class="is-active"');
    expect(markup).toContain('aria-label="Replay from first event"');
    expect(markup).toContain('aria-label="Follow live events"');
    expect(markup).toContain("Event 0 / 0");
    expect(markup).toContain("runtime-canvas-preparing");
    expect(markup).toContain('aria-busy="true"');
    expect(markup).not.toContain("Computing flow layout");
    expect(markup).not.toContain("Listening for CLI activity");
    expect(markup).not.toContain("observer-empty");
    expect(markup).not.toContain("Run Agent");
    expect(markup).not.toContain("Evaluation mode");
    expect(markup).not.toContain("Cancel");
  });

  it("uses high-contrast selection colors, larger panel text, and readable flow nodes", () => {
    expect(styles).toContain("font-family: system-ui, sans-serif");
    expect(styles).not.toContain("@fontsource-variable/geist");
    expect(styles).not.toContain("Geist Variable");
    expect(styles).toContain("--selection-border: #22d3ee");
    expect(styles).toContain("--selection-text: #ecfeff");
    expect(styles).toMatch(
      /\.run-history button\.is-selected\s*\{[^}]*var\(--selection-border\)/su,
    );
    expect(styles).toMatch(/\.atom-node\.is-observed\s*\{[^}]*#8b83f6/su);
    expect(styles).toMatch(/\.atom-node\.is-selected\s*\{[^}]*var\(--selection-border\)/su);
    expect(styles).toMatch(
      /\.atom-node\.status-running\.is-execution-active \.atom-status\s*\{[^}]*animation:/su,
    );
    expect(styles).toMatch(/\.edge\.is-selected\s*\{[^}]*var\(--selection-text\)/su);
    expect(styles).toMatch(/\.atomic-log-row\.is-selected\s*\{[^}]*var\(--selection-border\)/su);
    expect(styles).toMatch(/\.trajectory-row\.is-selected\s*\{[^}]*var\(--selection-border\)/su);
    expect(styles).toMatch(
      /\.trajectory-branch\s*\{[^}]*left: calc\(20\.5px \+ var\(--trajectory-depth\) \* 17px\);/su,
    );
    expect(styles).toMatch(
      /\.trajectory-row\s*\{[^}]*content-visibility: auto;[^}]*contain-intrinsic-size:/su,
    );
    expect(styles).toMatch(/\.run-history button strong\s*\{[^}]*font-size: 11px/su);
    expect(styles).toMatch(/\.run-history button small\s*\{[^}]*font-size: 9\.5px/su);
    expect(styles).toMatch(/\.atomic-log-row\s*\{[^}]*font-size: 11px/su);
    expect(styles).toMatch(/\.atomic-log-row strong\s*\{[^}]*font-size: 11\.5px/su);
    expect(styles).toMatch(/\.atomic-log-row small\s*\{[^}]*font-size: 10px/su);
    expect(styles).toMatch(
      /\.atomic-log-heading\s*\{[^}]*display: flex;[^}]*align-items: center;/su,
    );
    expect(styles).toMatch(/\.message-inspector pre\s*\{[^}]*font-size: 11px/su);
    expect(styles).toMatch(
      /\.trajectory-heading > div\s*\{[^}]*display: flex;[^}]*align-items: baseline;/su,
    );
    expect(styles).toMatch(
      /\.trajectory-overview-scroll\s*\{[^}]*overflow-x: auto;[^}]*scrollbar-gutter: stable;[^}]*scrollbar-width: thin;/su,
    );
    expect(styles).toMatch(
      /\.trajectory-overview-tracks\s*\{[^}]*padding-bottom: 7px;[^}]*border-bottom: 1px solid #252c3a;/su,
    );
    expect(styles).toMatch(
      /\.trajectory-overview-track i\s*\{[^}]*width: 100%;[^}]*height: 8px;[^}]*cursor: help;/su,
    );
    expect(styles).toMatch(
      /\.trajectory-overview-track i\.is-locating\s*\{[^}]*animation: trajectory-stream-locate 1\.4s ease-out;/su,
    );
    expect(styles).toMatch(
      /\.eval-summary-dimensions\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/su,
    );
    expect(styles).toMatch(/\.flow-edges\s*\{[^}]*width: 100%;[^}]*height: 100%;/su);
    expect(styles).toMatch(/\.edge-track\s*\{[^}]*stroke-width: 3\.6;/su);
    expect(styles).toMatch(
      /\.edge-hit-target\s*\{[^}]*stroke: transparent;[^}]*stroke-width: 12;[^}]*pointer-events: stroke;/su,
    );
    expect(styles).toMatch(/\.edge-casing\s*\{[^}]*stroke-width: 4\.6;[^}]*opacity: 0\.92;/su);
    expect(styles).toMatch(/\.edge-route:hover \.edge-hover-overlay\s*\{[^}]*opacity: 1;/su);
    expect(styles).toMatch(/\.edge-route:hover \.edge-port\s*\{[^}]*var\(--selection-text\)/su);
    expect(styles).toMatch(/\.edge\s*\{[^}]*stroke-width: 1\.5;/su);
    expect(styles).toMatch(/\.edge\.is-active\s*\{[^}]*stroke-width: 2;/su);
    expect(styles).toMatch(/\.edge\.is-flowing\s*\{[^}]*animation: edge-flow/su);
    expect(styles).toMatch(
      /\.edge\.is-flowing\.is-trajectory-flow\s*\{[^}]*animation-duration: 2\.2s;/su,
    );
    expect(styles).toMatch(
      /\.edge-flow-beam\.is-trajectory-flow,[^{]*\.edge-target-pulse\.is-trajectory-flow\s*\{[^}]*animation-duration: 2\.5s;/su,
    );
    expect(styles).toMatch(/\.edge\.is-selected\s*\{[^}]*stroke-width: 2\.3;/su);
    expect(styles).toMatch(/\.edge-flow-beam\s*\{[^}]*stroke-width: 3;/su);
    expect(styles).toMatch(/--right-panel-width: 320px/su);
    expect(styles).toMatch(
      /\.atom-node\s*\{[^}]*min-width: 106px;[^}]*height: 50px;[^}]*padding: 9px 8px 7px;/su,
    );
    expect(styles).toMatch(
      /\.atom-node strong\s*\{[^}]*font-size: 12px;[^}]*white-space: nowrap;/su,
    );
    expect(styles).not.toMatch(/\.atom-node strong\s*\{[^}]*text-overflow: ellipsis;/su);
    expect(styles).toMatch(/\.atom-node small\s*\{[^}]*font-size: 8\.5px/su);
    expect(styles).toMatch(/\.atom-count\s*\{[^}]*font-size: 7px/su);
    expect(styles).toMatch(
      /\.atom-invocation\s*\{[^}]*display: flex;[^}]*overflow: hidden;[^}]*white-space: nowrap;/su,
    );
    expect(styles).toMatch(/\.atom-invocation-mcp\s*\{[^}]*#38bdf8/su);
    expect(styles).toMatch(/\.atom-invocation-skill\s*\{[^}]*#fbbf24/su);
    expect(styles).toMatch(
      /\.atom-count\s*\{[^}]*position: absolute;[^}]*top: -6px;[^}]*right: -6px;/su,
    );
    expect(styles).toMatch(
      /\.atom-focus\s*\{[^}]*position: absolute;[^}]*right: -10px;[^}]*bottom: -7px;[^}]*padding: 2px 3px;/su,
    );
    expect(styles).toMatch(
      /\.flow-guide-drawer\s*\{[^}]*position: fixed;[^}]*right: 0;[^}]*width: min\(520px,[^}]*height: 100dvh;/su,
    );
    expect(styles).toMatch(
      /\.flow-guide-drawer\s*\{[^}]*transform: translateX\(28px\);[^}]*transition:/su,
    );
    expect(styles).toMatch(
      /\.flow-guide-drawer\.is-open\s*\{[^}]*transform: translateX\(0\);[^}]*visibility: visible;/su,
    );
    expect(styles).toMatch(/\.flow-guide-content\s*\{[^}]*min-height: 0;[^}]*overflow-y: auto;/su);
    expect(styles).toMatch(
      /\.flow-guide-search\s*\{[^}]*position: sticky;[^}]*top: 4px;[^}]*z-index: 2;/su,
    );
    expect(styles).not.toContain(".flow-guide-backdrop");
    expect(styles).toContain("@keyframes log-scroll-control-in");
    expect(styles).toMatch(/\.flow-guide-atom\s*\{[^}]*border-top:/su);
    expect(styles).toMatch(
      /\.studio-navigation-drawer\s*\{[^}]*position: fixed;[^}]*top: 64px;[^}]*left: 0;[^}]*width: min\(320px,/su,
    );
    expect(styles).toMatch(
      /\.studio-navigation-drawer\.is-open\s*\{[^}]*transform: translateX\(0\)/su,
    );
    expect(styles).toMatch(
      /\.status-samples i\s*\{[^}]*flex: 0 0 7px;[^}]*width: 7px;[^}]*height: 7px;[^}]*border-radius: 999px;/su,
    );
    expect(styles).toMatch(/\.status-samples \[data-status="failed"\]\s*\{[^}]*var\(--red\)/su);
    expect(styles).toMatch(
      /\.runtime-canvas-preparing\s*\{[^}]*position: absolute;[^}]*inset: 0;[^}]*background-image:/su,
    );
    expect(styles).toMatch(
      /\.runtime-canvas-viewport\s*\{[^}]*padding: 12px;[^}]*overflow: hidden;/su,
    );
    expect(styles).toMatch(/\.run-history button\s*\{[^}]*overflow: hidden;/su);
    expect(styles).not.toMatch(/\.run-history button\s*\{[^}]*max-height:/su);
    expect(styles).toMatch(
      /\.run-history-meta-row\s*\{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/su,
    );
    expect(styles).toMatch(
      /\.run-history-agent-tag\s*\{[^}]*display: inline-flex;[^}]*border-radius: 999px;/su,
    );
    expect(styles).not.toContain(".run-history button:hover strong");
    expect(styles).not.toContain(".flow-guide-domain-grid article:last-child");
    expect(styles).toMatch(
      /\.runtime-canvas-fit\.is-reflowing\s*\{[^}]*opacity: 0\.72;[^}]*filter:/su,
    );
    expect(styles).toMatch(/\.runtime-canvas-routing-indicator\s*\{[^}]*position: absolute;/su);
    expect(styles).not.toContain("@keyframes canvas-layout-scan");
    expect(styles).toContain("@keyframes flow-skeleton-phase");
    expect(styles).toContain("@keyframes flow-skeleton-route");
    expect(styles).toContain("@keyframes flow-canvas-enter");
    expect(styles).toContain("@keyframes canvas-layout-pulse");
    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.runtime-canvas-fit,[\s\S]*\.flow-skeleton-edge path,[\s\S]*\.runtime-canvas-routing-indicator i\s*\{[^}]*animation: none;[^}]*transition: none;/su,
    );
    expect(styles).not.toMatch(/\.atom-node strong\s*\{[^}]*padding-right:/su);
  });

  it("places plugin navigation and Header actions in the original Header", () => {
    const extension: StudioClientPlugin = {
      manifest: {
        capabilities: ["pages.workspace"],
        id: "workspace",
        name: "Workspace",
        requires: ["yiku.agent-observatory"],
        studioVersion: "0.1",
        version: "0.1.0",
      },
      navigation: [{ id: "workspace", label: "Workspace", pageId: "workspace" }],
      pages: [
        {
          component: () => <div>Workspace</div>,
          id: "workspace",
          path: "/workspace",
          title: "Workspace",
        },
      ],
      slots: [
        {
          component: () => <span>PLUGIN STATUS</span>,
          id: "status",
          slot: "header.actions",
        },
      ],
    };
    const markup = renderToStaticMarkup(
      <StudioProvider plugins={[agentObservatoryClientPlugin(), extension]}>
        <App />
      </StudioProvider>,
    );

    expect(markup).toContain("Yiku Agent Observatory");
    expect(markup).toContain("Open Studio menu");
    expect(markup).toContain("PLUGIN STATUS");
    expect(markup).toContain('class="studio-navigation-drawer"');
    expect(markup).not.toContain("LOCAL CAPABILITY HOST");
  });
});
