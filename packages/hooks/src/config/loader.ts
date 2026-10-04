import { readFile } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { HookConfigError } from "../errors.js";
import type { HookEventName, HookHandler, HookSourceType } from "../types.js";
import { parseHookFrontmatter } from "./frontmatter.js";
import { compareHookSources, hookSource } from "./source.js";
import type {
  HookComponentFrontmatter,
  HookConfigDocument,
  HookConfigLoaderOptions,
  RuntimeHookRegistration,
} from "./types.js";

export class HookConfigLoader {
  private readonly read: (path: string) => Promise<string>;

  public constructor(private readonly options: HookConfigLoaderOptions = {}) {
    this.read = options.readFile ?? ((path) => readFile(path, "utf8"));
  }

  public async load(): Promise<readonly HookConfigDocument[]> {
    const documents: HookConfigDocument[] = [];

    if (this.options.managedSettings !== undefined) {
      documents.push({
        source: hookSource("managed"),
        value: this.options.managedSettings,
      });
    }

    await this.loadFile(documents, "user", this.options.userSettingsPath);
    await this.loadFile(documents, "project", this.options.projectSettingsPath);
    await this.loadFile(documents, "local", this.options.localSettingsPath);

    for (const path of this.options.pluginSettingsPaths ?? []) {
      await this.loadFile(documents, "plugin", path, basename(path));
    }

    for (const component of this.options.components ?? []) {
      this.loadComponent(documents, component);
    }

    for (const registration of this.options.runtimeHooks ?? []) {
      documents.push(runtimeDocument(registration));
    }

    return Object.freeze(
      documents.sort((left, right) => compareHookSources(left.source, right.source)),
    );
  }

  private async loadFile(
    documents: HookConfigDocument[],
    type: Extract<HookSourceType, "local" | "plugin" | "project" | "user">,
    path?: string,
    componentId?: string,
  ): Promise<void> {
    if (path === undefined) {
      return;
    }

    requireAbsolutePath(path, type);

    let content: string;
    try {
      content = await this.read(path);
    } catch (error) {
      if (isNotFoundError(error)) {
        return;
      }

      throw new HookConfigError("HOOK_CONFIG_INVALID", `Unable to read ${type} Hook settings.`, {
        cause: error,
        sourceType: type,
      });
    }

    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch (error) {
      throw new HookConfigError("HOOK_CONFIG_INVALID", `${type} Hook settings are invalid JSON.`, {
        cause: error,
        sourceType: type,
      });
    }

    documents.push({
      source: hookSource(type, {
        ...(componentId !== undefined ? { componentId } : {}),
        path,
      }),
      value,
    });
  }

  private loadComponent(
    documents: HookConfigDocument[],
    component: HookComponentFrontmatter,
  ): void {
    const value = parseHookFrontmatter(component.content, {
      componentId: component.componentId,
      sourceType: component.type,
    });

    if (value === undefined) {
      return;
    }

    documents.push({
      source: hookSource(component.type, {
        componentId: component.componentId,
        ...(component.path !== undefined ? { path: component.path } : {}),
      }),
      value,
    });
  }
}

function runtimeDocument(registration: RuntimeHookRegistration): HookConfigDocument {
  return {
    source: hookSource("runtime", {
      componentId: registration.handler.name,
    }),
    value: runtimeSettings(registration.eventName, registration.handler, registration.matcher),
  };
}

function runtimeSettings(
  eventName: HookEventName,
  handler: Extract<HookHandler, { readonly type: "callback" }>,
  matcher?: string,
): unknown {
  return {
    hooks: {
      [eventName]: [
        {
          hooks: [handler],
          ...(matcher !== undefined ? { matcher } : {}),
        },
      ],
    },
  };
}

function requireAbsolutePath(path: string, type: HookSourceType): void {
  if (!isAbsolute(path)) {
    throw new HookConfigError(
      "HOOK_CONFIG_INVALID",
      `${type} Hook settings path must be absolute.`,
      {
        sourceType: type,
      },
    );
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
