import type { StudioPluginManifest } from "./types.js";

const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;

export interface StudioPlugin {
  readonly manifest: StudioPluginManifest;
}

export class StudioPluginError extends Error {
  public constructor(
    public readonly code:
      | "PLUGIN_CYCLE"
      | "PLUGIN_DUPLICATE"
      | "PLUGIN_ID_INVALID"
      | "PLUGIN_MISSING"
      | "PLUGIN_VERSION_UNSUPPORTED",
    message: string,
  ) {
    super(message);
    this.name = "StudioPluginError";
  }
}

export function orderStudioPlugins<T extends StudioPlugin>(
  plugins: readonly T[],
  studioVersion?: string,
): readonly T[] {
  const byId = new Map<string, T>();
  for (const plugin of plugins) {
    const { id } = plugin.manifest;
    if (!PLUGIN_ID_PATTERN.test(id)) {
      throw new StudioPluginError(
        "PLUGIN_ID_INVALID",
        `Studio plugin ID "${id}" must use lowercase dot or kebab notation.`,
      );
    }
    if (byId.has(id)) {
      throw new StudioPluginError(
        "PLUGIN_DUPLICATE",
        `Studio plugin "${id}" is registered more than once.`,
      );
    }
    if (studioVersion !== undefined && plugin.manifest.studioVersion !== studioVersion) {
      throw new StudioPluginError(
        "PLUGIN_VERSION_UNSUPPORTED",
        `Studio plugin "${id}" targets ${plugin.manifest.studioVersion}, expected ${studioVersion}.`,
      );
    }
    byId.set(id, plugin);
  }

  for (const plugin of plugins) {
    for (const dependencyId of plugin.manifest.requires ?? []) {
      if (!byId.has(dependencyId)) {
        throw new StudioPluginError(
          "PLUGIN_MISSING",
          `Studio plugin "${plugin.manifest.id}" requires missing plugin "${dependencyId}".`,
        );
      }
    }
  }

  const ordered: T[] = [];
  const complete = new Set<string>();
  const visiting = new Set<string>();
  const path: string[] = [];

  const visit = (plugin: T): void => {
    const pluginId = plugin.manifest.id;
    if (complete.has(pluginId)) {
      return;
    }
    if (visiting.has(pluginId)) {
      const cycleStart = path.indexOf(pluginId);
      const cycle = [...path.slice(cycleStart), pluginId].join(" -> ");
      throw new StudioPluginError("PLUGIN_CYCLE", `Studio plugin dependency cycle: ${cycle}.`);
    }

    visiting.add(pluginId);
    path.push(pluginId);
    for (const dependencyId of plugin.manifest.requires ?? []) {
      const dependency = byId.get(dependencyId);
      if (dependency !== undefined) {
        visit(dependency);
      }
    }
    path.pop();
    visiting.delete(pluginId);
    complete.add(pluginId);
    ordered.push(plugin);
  };

  for (const plugin of plugins) {
    visit(plugin);
  }
  return ordered;
}

export function assertUniqueContributions(
  contributionType: string,
  entries: readonly {
    readonly id: string;
    readonly pluginId: string;
  }[],
): void {
  const owners = new Map<string, string>();
  for (const entry of entries) {
    const owner = owners.get(entry.id);
    if (owner !== undefined) {
      throw new StudioPluginError(
        "PLUGIN_DUPLICATE",
        `${contributionType} "${entry.id}" is contributed by both "${owner}" and "${entry.pluginId}".`,
      );
    }
    owners.set(entry.id, entry.pluginId);
  }
}
