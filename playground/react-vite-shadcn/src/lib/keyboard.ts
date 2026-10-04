import { useEffect, useSyncExternalStore } from "react";

/**
 * Determine whether a keyboard event originated from an editable element
 * (input / textarea / select / contentEditable). Global shortcut handlers
 * should ignore such events so they don't hijack text input.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

type ShortcutHandler = (e: KeyboardEvent) => void;

interface ShortcutOptions {
  /** Enable/disable the whole listener (useful for focus-scoped cards). */
  enabled?: boolean;
}

/**
 * Register a window-level keydown listener that only fires when the user is
 * not typing in an editable control.
 *
 * This hook centralizes the "ignore inputs" guard across cards so they don't
 * drift apart in behavior (e.g. forgetting to exclude contentEditable).
 */
export function useGlobalShortcuts(
  handler: ShortcutHandler,
  deps: React.DependencyList,
  options: ShortcutOptions = {},
) {
  const { enabled = true } = options;
  useEffect(() => {
    if (!enabled) return;
    const listener = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      handler(e);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [enabled, ...deps, handler]);
}

/**
 * Registry of active focus scopes. Only the most recently activated scope
 * receives keyboard shortcuts, preventing conflicts when multiple cards
 * listen for the same keys (Space, R, etc.).
 */
const activeScopes = new Set<string>();
let activationOrder: string[] = [];
const listeners = new Set<() => void>();

function notifyChange() {
  for (const fn of listeners) fn();
}

/** Subscribe to active-scope changes; returns an unsubscribe function. */
export function subscribeToActiveScopes(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Get the currently active scope id (most recently activated), or null. */
export function getActiveScope(): string | null {
  return activationOrder.length > 0 ? activationOrder[activationOrder.length - 1] : null;
}

/** Activate a scope (e.g. on card click/focus). */
export function activateScope(scopeId: string) {
  if (!activeScopes.has(scopeId)) {
    activeScopes.add(scopeId);
    activationOrder = [...activationOrder.filter((id) => id !== scopeId), scopeId];
    notifyChange();
  } else {
    // Move to top of activation order
    activationOrder = [...activationOrder.filter((id) => id !== scopeId), scopeId];
    notifyChange();
  }
}

/** Deactivate a scope (e.g. on blur). */
export function deactivateScope(scopeId: string) {
  if (activeScopes.has(scopeId)) {
    activeScopes.delete(scopeId);
    activationOrder = activationOrder.filter((id) => id !== scopeId);
    notifyChange();
  }
}

/**
 * React hook that returns the currently active scope id and re-renders when it
 * changes.
 */
export function useActiveScope(): string | null {
  return useSyncExternalStore(
    (cb) => subscribeToActiveScopes(cb),
    () => getActiveScope(),
    () => null,
  );
}

/**
 * Hook that returns whether the given scope is the currently active one.
 * Pass the result as `enabled` to `useGlobalShortcuts` to scope shortcuts
 * to a particular card.
 */
export function useScopeActive(scopeId: string): boolean {
  const active = useActiveScope();
  return active === scopeId;
}

/**
 * Hook that activates a keyboard scope when the returned ref's element is
 * focused or clicked, and deactivates it on blur. This gives each card an
 * isolated shortcut context so that e.g. Space only controls one card at a
 * time instead of toggling every card on the page simultaneously.
 *
 * Usage:
 *   const scopeRef = useScope("counter");
 *   useGlobalShortcuts(handler, deps, { enabled: useScopeActive("counter") });
 *   return <div ref={scopeRef} tabIndex={0}>...</div>
 */
export function useScope(scopeId: string) {
  const refCallback = (node: HTMLElement | null) => {
    if (!node) return;
    node.tabIndex = node.tabIndex < 0 ? 0 : node.tabIndex;
    if (!node.dataset.scopeBound) {
      node.dataset.scopeBound = "1";
      node.addEventListener("focus", () => activateScope(scopeId));
      node.addEventListener("click", () => {
        node.focus();
        activateScope(scopeId);
      });
      node.addEventListener("blur", () => deactivateScope(scopeId));
    }
  };
  return refCallback;
}
