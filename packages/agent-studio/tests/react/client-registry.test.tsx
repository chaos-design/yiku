import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createStudioClientRegistry } from "../../src/react/client-registry.js";
import { StudioProvider, useStudio } from "../../src/react/studio-provider.js";
import { StudioEventView, StudioShell } from "../../src/react/studio-shell.js";
import type { StudioClientPlugin } from "../../src/react/types.js";
import type { StudioPluginManifest } from "../../src/types.js";

const manifest = (id: string): StudioPluginManifest => ({
  capabilities: ["pages"],
  id,
  name: id,
  studioVersion: "0.1",
  version: "0.1.0",
});

const Page = ({ pluginId }: { readonly pluginId: string }) => <div>page:{pluginId}</div>;

describe("createStudioClientRegistry", () => {
  it("combines and orders client contributions", () => {
    const registry = createStudioClientRegistry([
      {
        manifest: manifest("one"),
        navigation: [{ id: "second", label: "Second", order: 20, pageId: "second-page" }],
        pages: [{ component: Page, id: "second-page", path: "/second", title: "Second" }],
        themeTokens: { "--studio-accent": "#ffffff" },
      },
      {
        manifest: manifest("two"),
        navigation: [{ id: "first", label: "First", order: 10, pageId: "first-page" }],
        pages: [{ component: Page, id: "first-page", path: "/first", title: "First" }],
      },
    ]);

    expect(registry.navigation.map((item) => item.id)).toEqual(["first", "second"]);
    expect(registry.themeTokens).toEqual({ "--studio-accent": "#ffffff" });
  });

  it("rejects missing pages and duplicate routes", () => {
    expect(() =>
      createStudioClientRegistry([
        {
          manifest: manifest("one"),
          navigation: [{ id: "missing", label: "Missing", pageId: "none" }],
        },
      ]),
    ).toThrow('references missing page "none"');

    expect(() =>
      createStudioClientRegistry([
        {
          manifest: manifest("one"),
          pages: [
            { component: Page, id: "one", path: "/same", title: "One" },
            { component: Page, id: "two", path: "/same", title: "Two" },
          ],
        },
      ]),
    ).toThrow("Page");
  });

  it("collects every optional contribution family and rejects duplicate IDs", () => {
    const full: StudioClientPlugin = {
      eventRenderers: [
        {
          component: () => null,
          id: "event",
          matches: () => true,
        },
      ],
      graphProviders: [
        {
          id: "graph",
          project: () => ({ edges: [], nodes: [] }),
        },
      ],
      manifest: manifest("full"),
      navigation: [{ id: "nav", label: "Full", pageId: "page" }],
      pages: [{ component: Page, id: "page", path: "/page", title: "Page" }],
      runActions: [{ id: "action", label: "Action", run: () => undefined }],
      slots: [
        {
          component: () => null,
          id: "slot",
          slot: "page.footer",
        },
      ],
    };
    const registry = createStudioClientRegistry([full]);
    expect(registry.eventRenderers).toHaveLength(1);
    expect(registry.graphProviders).toHaveLength(1);
    expect(registry.runActions).toHaveLength(1);
    expect(registry.slots).toHaveLength(1);

    expect(() =>
      createStudioClientRegistry([
        full,
        {
          manifest: manifest("duplicate"),
          runActions: [{ id: "action", label: "Duplicate", run: () => undefined }],
        },
      ]),
    ).toThrow("Run action");
  });
});

describe("StudioShell", () => {
  it("renders the selected plugin page without global navigation chrome", () => {
    const plugins: readonly StudioClientPlugin[] = [
      {
        manifest: manifest("workspace"),
        navigation: [
          { id: "home-nav", label: "Home", order: 1, pageId: "home" },
          { id: "tools-nav", label: "Tools", order: 2, pageId: "tools" },
        ],
        pages: [
          { component: Page, id: "home", path: "/", title: "Home" },
          { component: Page, id: "tools", path: "/tools", title: "Tools" },
        ],
      },
    ];

    const html = renderToStaticMarkup(
      <StudioShell initialPath="/tools" plugins={plugins} productName="Test Studio" />,
    );

    expect(html).toContain("page:workspace");
    expect(html).not.toContain("Test Studio");
    expect(html).not.toContain("<nav");
    expect(html).not.toContain("LOCAL CAPABILITY HOST");
  });

  it("falls back to the raw JSON inspector for unknown events", () => {
    const html = renderToStaticMarkup(
      <StudioProvider plugins={[]}>
        <StudioEventView
          event={{
            eventId: "event-1",
            occurredAt: "2026-08-07T00:00:00.000Z",
            runId: "run-1",
            sequence: 1,
          }}
        />
      </StudioProvider>,
    );

    expect(html).toContain("Raw event");
    expect(html).toContain("event-1");
  });

  it("requires the Studio Provider", () => {
    function Consumer() {
      useStudio();
      return null;
    }

    expect(() => renderToStaticMarkup(<Consumer />)).toThrow("inside StudioProvider");
  });
});
