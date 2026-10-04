export {
  assertStudioManifestCompatibility,
  loadStudioManifest,
  pluginRequest,
  StudioClientError,
} from "./client.js";
export { createStudioClientRegistry } from "./client-registry.js";
export {
  StudioNavigationDrawer,
  type StudioNavigationDrawerProps,
} from "./studio-navigation-drawer.js";
export {
  StudioProvider,
  type StudioProviderProps,
  useStudio,
} from "./studio-provider.js";
export {
  StudioEventView,
  StudioJsonInspector,
  StudioShell,
  type StudioShellProps,
  StudioSlot,
} from "./studio-shell.js";
export type {
  StudioClientPlugin,
  StudioClientRegistry,
  StudioEventRendererContribution,
  StudioEventRendererProps,
  StudioGraphProjection,
  StudioGraphProviderContribution,
  StudioNavigationContribution,
  StudioPageContribution,
  StudioPageProps,
  StudioRunActionContribution,
  StudioSlotContribution,
  StudioSlotName,
  StudioSlotProps,
} from "./types.js";
