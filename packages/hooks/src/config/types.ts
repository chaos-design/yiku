import type { HookCondition } from "../matching/condition.js";
import type { HookMatcher } from "../matching/matcher.js";
import type {
  HookDiagnostic,
  HookEvent,
  HookEventName,
  HookHandler,
  HookSource,
} from "../types.js";

export interface HookConfigDocument {
  readonly source: HookSource;
  readonly value: unknown;
}

export interface HookComponentFrontmatter {
  readonly componentId: string;
  readonly content: string;
  readonly path?: string | undefined;
  readonly type: "agent" | "skill";
}

export interface HookConfigLoaderOptions {
  readonly components?: readonly HookComponentFrontmatter[] | undefined;
  readonly localSettingsPath?: string | undefined;
  readonly managedSettings?: unknown;
  readonly pluginSettingsPaths?: readonly string[] | undefined;
  readonly projectSettingsPath?: string | undefined;
  readonly readFile?: ((path: string) => Promise<string>) | undefined;
  readonly runtimeHooks?: readonly RuntimeHookRegistration[] | undefined;
  readonly userSettingsPath?: string | undefined;
}

export interface RuntimeHookRegistration {
  readonly eventName: HookEventName;
  readonly handler: Extract<HookHandler, { readonly type: "callback" }>;
  readonly matcher?: string | undefined;
}

export interface HookMatcherGroupConfig {
  readonly hooks: readonly HookHandler[];
  readonly matcher?: string | undefined;
}

export interface HookSettingsConfig {
  readonly hooks: Readonly<Partial<Record<HookEventName, readonly HookMatcherGroupConfig[]>>>;
}

export interface CompiledHook {
  readonly condition?: HookCondition | undefined;
  readonly eventName: HookEventName;
  readonly handler: HookHandler;
  readonly hookId: string;
  readonly jsonPointer: string;
  readonly matcher: HookMatcher;
  readonly source: HookSource;
}

export interface HookConfigCompilation {
  readonly diagnostics: readonly HookDiagnostic[];
  readonly snapshot: HookConfigSnapshotView;
}

export interface HookConfigSnapshotView {
  readonly diagnostics: readonly HookDiagnostic[];
  readonly hooks: readonly CompiledHook[];
  readonly version: string;
  forEvent(eventName: HookEventName): readonly CompiledHook[];
  matches(event: HookEvent): readonly CompiledHook[];
}
