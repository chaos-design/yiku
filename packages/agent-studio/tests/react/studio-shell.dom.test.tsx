// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioNavigationDrawer } from "../../src/react/studio-navigation-drawer.js";
import { StudioProvider } from "../../src/react/studio-provider.js";
import { StudioEventView, StudioShell, StudioSlot } from "../../src/react/studio-shell.js";
import type { StudioClientPlugin } from "../../src/react/types.js";
import type { StudioPluginManifest } from "../../src/types.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const roots: Root[] = [];

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });
  document.body.innerHTML = "";
  window.location.hash = "";
  vi.unstubAllGlobals();
});

describe("StudioShell DOM", () => {
  it("validates manifests, renders slots and follows hash navigation", async () => {
    const plugins = clientPlugins();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(plugins.map((plugin) => plugin.manifest)), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          }),
      ),
    );
    const container = mount(
      <StudioShell initialPath="/" plugins={plugins} productName="DOM Studio" />,
    );
    await flush();

    expect(container.textContent).not.toContain("DOM Studio");
    expect(container.textContent).toContain("First page");
    expect(container.textContent).toContain("READY");
    expect(container.querySelector(".studio-page-host > header")).toBeNull();
    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open Studio menu"]',
    );
    act(() => trigger?.click());
    await flush();
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[aria-current="page"]')).toBe(document.activeElement);

    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    await flush();
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);

    act(() => trigger?.click());
    const backdrop = container.querySelector<HTMLButtonElement>(".studio-navigation-backdrop");
    act(() => backdrop?.click());
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");

    act(() => trigger?.click());
    const second = [...container.querySelectorAll("[data-studio-navigation-item]")].find((button) =>
      button.textContent?.includes("Second"),
    ) as HTMLButtonElement | undefined;
    expect(second).toBeDefined();
    await act(async () => {
      second?.click();
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(container.textContent).toContain("Second page");
    expect(
      [...container.querySelectorAll("[data-studio-navigation-item]")]
        .find((button) => button.textContent?.includes("Second"))
        ?.getAttribute("aria-current"),
    ).toBe("page");
  });

  it("shows manifest request and compatibility failures", async () => {
    const plugins = clientPlugins();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("[]", {
            headers: { "Content-Type": "application/json" },
            status: 200,
          }),
      ),
    );
    const mismatch = mount(<StudioShell plugins={plugins} productName="Mismatch" />);
    await flush();
    expect(mismatch.textContent).toContain("PLUGIN MANIFEST MISMATCH");
    expect(mismatch.textContent).toContain("does not provide");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );
    const offline = mount(<StudioShell plugins={plugins} productName="Offline" />);
    await flush();
    expect(offline.textContent).toContain("offline");
  });

  it("renders single-page, empty and event fallback states", async () => {
    const single = clientPlugins()[0];
    const singleContainer = mount(
      <StudioShell plugins={single === undefined ? [] : [single]} validateManifest={false} />,
    );
    await flush();
    expect(singleContainer.textContent).toContain("First page");
    const singleTrigger = singleContainer.querySelector<HTMLButtonElement>(
      'button[aria-label="Open Studio menu"]',
    );
    expect(singleTrigger).toBeDefined();
    act(() => singleTrigger?.click());
    await flush();
    expect(singleTrigger?.getAttribute("aria-expanded")).toBe("true");
    expect(singleContainer.querySelectorAll("[data-studio-navigation-item]")).toHaveLength(1);
    expect(
      singleContainer.querySelector("[data-studio-navigation-item]")?.getAttribute("aria-current"),
    ).toBe("page");

    const empty = mount(<StudioShell plugins={[]} productName="Empty" validateManifest={false} />);
    await flush();
    expect(empty.textContent).toContain("NO CLIENT CAPABILITY");

    const eventContainer = mount(
      <StudioProvider plugins={clientPlugins()}>
        <StudioEventView
          event={{
            eventId: "custom",
            occurredAt: "2026-08-07T00:00:00.000Z",
            runId: "run-1",
            sequence: 7,
          }}
        />
        <StudioSlot slot="page.footer" />
      </StudioProvider>,
    );
    await flush();
    expect(eventContainer.textContent).toContain("custom:7");
  });
});

function mount(element: ReactNode): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(element);
  });
  return container;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function clientPlugins(): readonly StudioClientPlugin[] {
  const firstManifest = manifest("first");
  const secondManifest: StudioPluginManifest = {
    ...manifest("second"),
    requires: ["first"],
  };
  return [
    {
      eventRenderers: [
        {
          component: ({ event }) => <div>{`custom:${event.sequence}`}</div>,
          id: "custom",
          matches: (event) => event.eventId === "custom",
        },
      ],
      manifest: firstManifest,
      navigation: [{ id: "first", label: "First", pageId: "first" }],
      pages: [
        {
          component: FirstPage,
          id: "first",
          path: "/",
          title: "First",
        },
      ],
      slots: [
        {
          component: () => <span>READY</span>,
          id: "ready",
          slot: "header.actions",
        },
      ],
    },
    {
      manifest: secondManifest,
      navigation: [{ id: "second", label: "Second", order: 2, pageId: "second" }],
      pages: [
        {
          component: SecondPage,
          id: "second",
          path: "/second",
          title: "Second",
        },
      ],
    },
  ];
}

function FirstPage() {
  return (
    <div>
      <StudioNavigationDrawer />
      <StudioSlot slot="header.actions" />
      First page
    </div>
  );
}

function SecondPage() {
  return (
    <div>
      <StudioNavigationDrawer />
      Second page
    </div>
  );
}

function manifest(id: string): StudioPluginManifest {
  return {
    capabilities: ["pages"],
    id,
    name: id,
    studioVersion: "0.1",
    version: "0.1.0",
  };
}
