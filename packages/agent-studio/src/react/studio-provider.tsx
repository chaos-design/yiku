import { createContext, type ReactNode, useContext, useMemo } from "react";
import { createStudioClientRegistry } from "./client-registry.js";
import type { StudioClientPlugin, StudioClientRegistry } from "./types.js";

const StudioContext = createContext<StudioClientRegistry | undefined>(undefined);

export interface StudioProviderProps {
  readonly children: ReactNode;
  readonly plugins: readonly StudioClientPlugin[];
}

export function StudioProvider({ children, plugins }: StudioProviderProps) {
  const registry = useMemo(() => createStudioClientRegistry(plugins), [plugins]);
  return <StudioContext.Provider value={registry}>{children}</StudioContext.Provider>;
}

export function useStudio(): StudioClientRegistry {
  const registry = useContext(StudioContext);
  if (registry === undefined) {
    throw new Error("useStudio must be used inside StudioProvider.");
  }
  return registry;
}

export function useOptionalStudio(): StudioClientRegistry | undefined {
  return useContext(StudioContext);
}
