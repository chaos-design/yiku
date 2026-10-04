import { useEffect, useId, useMemo, useRef, useState } from "react";
import { browserPath } from "./browser-path.js";
import { useOptionalStudio } from "./studio-provider.js";
import type { StudioClientRegistry } from "./types.js";

export interface StudioNavigationDrawerProps {
  readonly label?: string | undefined;
}

export function StudioNavigationDrawer({ label = "Menu" }: StudioNavigationDrawerProps) {
  const registry = useOptionalStudio();
  return registry === undefined ? null : (
    <StudioNavigationDrawerContent label={label} registry={registry} />
  );
}

function StudioNavigationDrawerContent({
  label,
  registry,
}: {
  readonly label: string;
  readonly registry: StudioClientRegistry;
}) {
  const drawerId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState(browserPath);
  const entries = useMemo(() => {
    const pages = new Map(registry.pages.map((page) => [page.id, page]));
    return registry.navigation.flatMap((item) => {
      const page = pages.get(item.pageId);
      return page === undefined ? [] : [{ item, page }];
    });
  }, [registry.navigation, registry.pages]);

  useEffect(() => {
    const update = () => setPath(browserPath());
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    const frame = window.requestAnimationFrame(() => {
      const current = drawerRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
      const first = drawerRef.current?.querySelector<HTMLElement>("[data-studio-navigation-item]");
      (current ?? first)?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  if (entries.length === 0) {
    return null;
  }

  const close = () => {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  return (
    <div className="studio-navigation">
      <button
        aria-controls={drawerId}
        aria-expanded={open}
        aria-label={`${open ? "Close" : "Open"} Studio menu`}
        className={`studio-navigation-trigger${open ? " is-open" : ""}`}
        onClick={() => setOpen((current) => !current)}
        ref={triggerRef}
        type="button"
      >
        <span aria-hidden="true" className="studio-navigation-icon">
          <i />
          <i />
          <i />
        </span>
        <span className="studio-navigation-label">{label}</span>
      </button>

      <button
        aria-hidden={!open}
        aria-label="Close Studio menu"
        className={`studio-navigation-backdrop${open ? " is-open" : ""}`}
        disabled={!open}
        onClick={close}
        tabIndex={-1}
        type="button"
      />
      <aside
        aria-hidden={!open}
        aria-label="Studio menu"
        aria-modal={open ? "true" : undefined}
        className={`studio-navigation-drawer${open ? " is-open" : ""}`}
        id={drawerId}
        inert={!open}
        ref={drawerRef}
        role="dialog"
      >
        <header className="studio-navigation-header">
          <div className="studio-navigation-heading">
            <span>CAPABILITY INDEX</span>
            <strong>Studio menu</strong>
          </div>
          <button aria-label="Close Studio menu" onClick={close} type="button">
            Close
          </button>
        </header>
        <nav aria-label="Studio pages" className="studio-navigation-list">
          {entries.map(({ item, page }, index) => {
            const current = page.path === path;
            return (
              <button
                aria-current={current ? "page" : undefined}
                className="studio-navigation-item"
                data-studio-navigation-item
                key={`${item.pluginId}:${item.id}`}
                onClick={() => {
                  window.location.hash = page.path;
                  close();
                }}
                type="button"
              >
                <span className="studio-navigation-index">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div className="studio-navigation-copy">
                  <strong>{item.label}</strong>
                  <small>{page.title}</small>
                </div>
                <i className="studio-navigation-state">{current ? "ACTIVE" : "OPEN"}</i>
              </button>
            );
          })}
        </nav>
      </aside>
    </div>
  );
}
