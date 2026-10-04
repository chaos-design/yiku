import { type CSSProperties, useEffect, useState } from "react";
import type { StudioEvent } from "../types.js";
import { browserPath } from "./browser-path.js";
import { assertStudioManifestCompatibility, loadStudioManifest } from "./client.js";
import { StudioProvider, useOptionalStudio, useStudio } from "./studio-provider.js";
import type { StudioClientPlugin, StudioSlotName } from "./types.js";

export interface StudioShellProps {
  readonly initialPath?: string | undefined;
  readonly plugins: readonly StudioClientPlugin[];
  readonly productName?: string | undefined;
  readonly validateManifest?: boolean | undefined;
}

export function StudioShell(props: StudioShellProps) {
  const [manifestError, setManifestError] = useState("");
  useEffect(() => {
    if (props.validateManifest === false || typeof window === "undefined") {
      return;
    }
    let active = true;
    void loadStudioManifest().then(
      (remote) => {
        try {
          assertStudioManifestCompatibility(
            props.plugins.map((plugin) => plugin.manifest),
            remote,
          );
        } catch (error) {
          if (active) {
            setManifestError(error instanceof Error ? error.message : String(error));
          }
        }
      },
      (error: unknown) => {
        if (active) {
          setManifestError(error instanceof Error ? error.message : String(error));
        }
      },
    );
    return () => {
      active = false;
    };
  }, [props.plugins, props.validateManifest]);

  if (manifestError) {
    return (
      <ManifestError message={manifestError} productName={props.productName ?? "Agent Studio"} />
    );
  }
  return (
    <StudioProvider plugins={props.plugins}>
      <StudioShellContent
        initialPath={props.initialPath}
        productName={props.productName ?? "Agent Studio"}
      />
    </StudioProvider>
  );
}

function ManifestError({
  message,
  productName,
}: {
  readonly message: string;
  readonly productName: string;
}) {
  return (
    <main style={EMPTY_STYLE}>
      <span style={KICKER_STYLE}>PLUGIN MANIFEST MISMATCH</span>
      <h1 style={EMPTY_TITLE_STYLE}>{productName}</h1>
      <p style={EMPTY_COPY_STYLE}>{message}</p>
    </main>
  );
}

function StudioShellContent({
  initialPath,
  productName,
}: {
  readonly initialPath?: string | undefined;
  readonly productName: string;
}) {
  const registry = useStudio();
  const [path, setPath] = useState(() => initialPath ?? browserPath());
  const firstPageId = registry.navigation[0]?.pageId;
  const fallbackPage =
    registry.pages.find((candidate) => candidate.id === firstPageId) ?? registry.pages[0];
  const page = registry.pages.find((candidate) => candidate.path === path) ?? fallbackPage;
  const theme = registry.themeTokens as CSSProperties;

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const update = () => setPath(browserPath());
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);

  if (page === undefined) {
    return <EmptyStudio productName={productName} />;
  }

  const Page = page.component;
  return (
    <div className="studio-page-host" style={{ ...theme, height: "100%", minHeight: 0 }}>
      <Page pluginId={page.pluginId} />
    </div>
  );
}

export function StudioSlot({ slot }: { readonly slot: StudioSlotName }) {
  const registry = useOptionalStudio();
  if (registry === undefined) {
    return null;
  }
  const entries = registry.slots.filter((entry) => entry.slot === slot);
  if (entries.length === 0) {
    return null;
  }
  return (
    <>
      {entries.map((entry) => {
        const SlotComponent = entry.component;
        return (
          <SlotComponent
            key={`${entry.pluginId}:${entry.id}`}
            pluginId={entry.pluginId}
            slot={slot}
          />
        );
      })}
    </>
  );
}

export function StudioEventView({ event }: { readonly event: StudioEvent }) {
  const registry = useStudio();
  const renderer = registry.eventRenderers.find((candidate) => candidate.matches(event));
  if (renderer === undefined) {
    return <StudioJsonInspector value={event} />;
  }
  const Renderer = renderer.component;
  return <Renderer event={event} />;
}

export function StudioJsonInspector({
  title = "Raw event",
  value,
}: {
  readonly title?: string | undefined;
  readonly value: unknown;
}) {
  return (
    <section style={INSPECTOR_STYLE}>
      <span style={KICKER_STYLE}>{title}</span>
      <pre style={PRE_STYLE}>{JSON.stringify(value, null, 2)}</pre>
    </section>
  );
}

function EmptyStudio({ productName }: { readonly productName: string }) {
  return (
    <main style={EMPTY_STYLE}>
      <span style={KICKER_STYLE}>NO CLIENT CAPABILITY</span>
      <h1 style={EMPTY_TITLE_STYLE}>{productName}</h1>
      <p style={EMPTY_COPY_STYLE}>Register a page contribution to start this Studio.</p>
    </main>
  );
}

const KICKER_STYLE: CSSProperties = {
  color: "var(--studio-muted, #718088)",
  display: "block",
  fontSize: 9,
  letterSpacing: "0.16em",
  marginBottom: 4,
  textTransform: "uppercase",
};

const INSPECTOR_STYLE: CSSProperties = {
  background: "var(--studio-surface, #12171a)",
  border: "1px solid var(--studio-border, #293136)",
  borderRadius: 3,
  padding: 14,
};

const PRE_STYLE: CSSProperties = {
  color: "var(--studio-foreground, #dce4e8)",
  font: "inherit",
  fontSize: 11,
  margin: 0,
  overflow: "auto",
  whiteSpace: "pre-wrap",
};

const EMPTY_STYLE: CSSProperties = {
  alignContent: "center",
  background: "#0b0e10",
  color: "#dce4e8",
  display: "grid",
  minHeight: "100vh",
  padding: "10vw",
};

const EMPTY_TITLE_STYLE: CSSProperties = {
  fontSize: "clamp(36px, 7vw, 96px)",
  letterSpacing: "-0.06em",
  margin: "8px 0 20px",
};

const EMPTY_COPY_STYLE: CSSProperties = {
  color: "#718088",
  fontSize: 13,
  margin: 0,
};
