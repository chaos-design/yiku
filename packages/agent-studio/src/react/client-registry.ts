import {
  assertUniqueContributions,
  orderStudioPlugins,
  StudioPluginError,
} from "../plugin-registry.js";
import type { StudioClientPlugin, StudioClientRegistry } from "./types.js";

const STUDIO_VERSION = "0.1";

export function createStudioClientRegistry(
  input: readonly StudioClientPlugin[],
): StudioClientRegistry {
  const plugins = orderStudioPlugins(input, STUDIO_VERSION);
  const pages = collect(plugins, (plugin) => plugin.pages);
  const navigation = collect(plugins, (plugin) => plugin.navigation);
  const slots = collect(plugins, (plugin) => plugin.slots);
  const eventRenderers = collect(plugins, (plugin) => plugin.eventRenderers);
  const runActions = collect(plugins, (plugin) => plugin.runActions);
  const graphProviders = collect(plugins, (plugin) => plugin.graphProviders);

  assertUniqueContributions(
    "Page",
    pages.flatMap((entry) => [
      { id: entry.id, pluginId: entry.pluginId },
      { id: `path:${entry.path}`, pluginId: entry.pluginId },
    ]),
  );
  assertUniqueContributions(
    "Navigation item",
    navigation.map((entry) => ({ id: entry.id, pluginId: entry.pluginId })),
  );
  assertUniqueContributions(
    "Slot item",
    slots.map((entry) => ({
      id: `${entry.slot}:${entry.id}`,
      pluginId: entry.pluginId,
    })),
  );
  assertUniqueContributions(
    "Event renderer",
    eventRenderers.map((entry) => ({ id: entry.id, pluginId: entry.pluginId })),
  );
  assertUniqueContributions(
    "Run action",
    runActions.map((entry) => ({ id: entry.id, pluginId: entry.pluginId })),
  );
  assertUniqueContributions(
    "Graph provider",
    graphProviders.map((entry) => ({ id: entry.id, pluginId: entry.pluginId })),
  );

  const pageIds = new Set(pages.map((page) => page.id));
  for (const item of navigation) {
    if (!pageIds.has(item.pageId)) {
      throw new StudioPluginError(
        "PLUGIN_MISSING",
        `Navigation item "${item.id}" references missing page "${item.pageId}".`,
      );
    }
  }

  return {
    eventRenderers: sortContributions(eventRenderers),
    graphProviders,
    navigation: sortContributions(navigation),
    pages,
    plugins,
    runActions,
    slots: sortContributions(slots),
    themeTokens: Object.assign({}, ...plugins.map((plugin) => plugin.themeTokens ?? {})),
  };
}

function collect<T>(
  plugins: readonly StudioClientPlugin[],
  select: (plugin: StudioClientPlugin) => readonly T[] | undefined,
): readonly (T & { readonly pluginId: string })[] {
  return plugins.flatMap((plugin) =>
    (select(plugin) ?? []).map((contribution) => ({
      ...contribution,
      pluginId: plugin.manifest.id,
    })),
  );
}

function sortContributions<T extends { readonly id: string; readonly order?: number | undefined }>(
  values: readonly T[],
): readonly T[] {
  return values.toSorted(
    (left, right) => (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id),
  );
}
