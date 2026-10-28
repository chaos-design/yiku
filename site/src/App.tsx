import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ArtifactView } from "./ArtifactView";
import { DocView } from "./DocView";
import { Gallery } from "./Gallery";
import { Header } from "./Header";
import { Home } from "./Home";
import { LangProvider } from "./i18n";
import { useHashRoute } from "./routes";
import { Sidebar } from "./Sidebar";

/** Must stay in sync with the mobile breakpoint in styles.css (860px). */
const MOBILE_NAV_QUERY = "(max-width: 860px)";

function Shell() {
  const route = useHashRoute();
  const contentRef = useRef<HTMLElement | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [navOpen, setNavOpen] = useState(false);
  // The content column owns the scroll position now, so a route change must
  // reset it explicitly — otherwise the next page opens mid-document.
  const routeKey = `${route.kind}:${"slug" in route ? route.slug : ""}`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: routeKey is a deliberate re-run trigger, not a value read inside the effect body.
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [routeKey]);

  const closeNav = useCallback((restoreFocus = false) => {
    setNavOpen(false);
    if (restoreFocus) toggleRef.current?.focus();
  }, []);

  // Any navigation closes the mobile panel; focus stays on the link the user
  // just activated rather than jumping back to the toggle.
  // biome-ignore lint/correctness/useExhaustiveDependencies: routeKey is a deliberate re-run trigger, not a value read inside the effect body.
  useEffect(() => {
    setNavOpen(false);
  }, [routeKey]);

  // Esc closes the panel and hands focus back to the toggle.
  useEffect(() => {
    if (!navOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeNav(true);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [navOpen, closeNav]);

  // Rotating to a desktop-width viewport must never leave the mobile panel open.
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_NAV_QUERY);
    const onChange = () => {
      if (!mq.matches) setNavOpen(false);
    };
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Opening moves the focus ring into the panel, so Tab walks its items next.
  useEffect(() => {
    if (navOpen) navRef.current?.focus();
  }, [navOpen]);

  // Opened panel: bring the current page's menu item into view. The panel may
  // have been left scrolled to wherever the user last closed it (or never
  // opened after navigating via the pager), so after the slide-in settles the
  // active item scrolls to the centre of the visible area.
  useEffect(() => {
    if (!navOpen) return;
    const timer = window.setTimeout(() => {
      document.querySelector<HTMLElement>(".sidebar .nav-item.active")?.scrollIntoView({
        block: "center",
      });
    }, 200); // let the 180ms slide-in finish first
    return () => window.clearTimeout(timer);
  }, [navOpen]);

  // Route change: keep the highlighted menu item reachable. The desktop rail
  // scrolls it near; with the mobile panel closed the element is hidden and
  // the call is a harmless no-op.
  // biome-ignore lint/correctness/useExhaustiveDependencies: routeKey is a deliberate re-run trigger, not a value read inside the effect body.
  useEffect(() => {
    document
      .querySelector<HTMLElement>(".sidebar .nav-item.active")
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
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
    <div className="shell" data-nav-open={navOpen ? "true" : "false"}>
      <Header open={navOpen} onToggle={() => setNavOpen((value) => !value)} toggleRef={toggleRef} />
      <Sidebar ref={navRef} route={route} onNavigate={() => closeNav(false)} />
      {navOpen ? (
        <div className="nav-backdrop" onClick={() => closeNav(true)} aria-hidden="true" />
      ) : null}
      <main className="content" ref={contentRef}>
        {view}
      </main>
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
