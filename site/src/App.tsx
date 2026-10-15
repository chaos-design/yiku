import { type ReactNode, useEffect, useRef } from "react";
import { ArtifactView } from "./ArtifactView";
import { BottomBar } from "./BottomBar";
import { DocView } from "./DocView";
import { Gallery } from "./Gallery";
import { Home } from "./Home";
import { LangProvider } from "./i18n";
import { useHashRoute } from "./routes";
import { Sidebar } from "./Sidebar";

function Shell() {
  const route = useHashRoute();
  const contentRef = useRef<HTMLElement>(null);
  const routeKey =
    route.kind === "doc" || route.kind === "artifact" ? `${route.kind}:${route.slug}` : route.kind;

  // The content column is now the app's only scroll surface, so reset its
  // position (not the window's) on every route change. `routeKey` is a stable
  // string that flips on navigation, unlike `route`, which `useHashRoute`
  // re-creates on every render; it is only a trigger, not a value read below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: routeKey is a deliberate re-run trigger, not a value read inside the effect body.
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [routeKey]);

  let view: ReactNode;
  switch (route.kind) {
    case "home":
      view = <Home />;
      break;
    case "doc":
      view = <DocView key={route.slug} slug={route.slug} />;
      break;
    case "artifact":
      view = <ArtifactView key={route.slug} slug={route.slug} />;
      break;
    case "gallery":
      view = <Gallery />;
      break;
    default:
      view = <Home />;
  }

  return (
    <div className="shell">
      <Sidebar route={route} />
      <main className="content" ref={contentRef}>
        {view}
      </main>
      <BottomBar />
    </div>
  );
}

export function App() {
  return (
    <LangProvider>
      <Shell />
    </LangProvider>
  );
}
