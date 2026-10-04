import type { ComponentType } from "react";
import type { StudioEvent, StudioPluginManifest, StudioRunSummary } from "../types.js";

export interface StudioPageProps {
  readonly pluginId: string;
}

export interface StudioPageContribution {
  readonly component: ComponentType<StudioPageProps>;
  readonly id: string;
  readonly path: `/${string}`;
  readonly title: string;
}

export interface StudioNavigationContribution {
  readonly id: string;
  readonly label: string;
  readonly order?: number | undefined;
  readonly pageId: string;
}

export interface StudioSlotProps {
  readonly pluginId: string;
  readonly slot: StudioSlotName;
}

export type StudioSlotName =
  | "event.inspector"
  | "header.actions"
  | "navigation.footer"
  | "page.footer"
  | "run.sidebar"
  | "run.toolbar";

export interface StudioSlotContribution {
  readonly component: ComponentType<StudioSlotProps>;
  readonly id: string;
  readonly order?: number | undefined;
  readonly slot: StudioSlotName;
}

export interface StudioEventRendererProps {
  readonly event: StudioEvent;
}

export interface StudioEventRendererContribution {
  readonly component: ComponentType<StudioEventRendererProps>;
  readonly id: string;
  readonly matches: (event: StudioEvent) => boolean;
  readonly order?: number | undefined;
}

export interface StudioRunActionContribution {
  readonly id: string;
  readonly isAvailable?: ((run: StudioRunSummary) => boolean) | undefined;
  readonly label: string;
  readonly run: (run: StudioRunSummary) => Promise<void> | void;
}

export interface StudioGraphProjection {
  readonly edges: readonly unknown[];
  readonly nodes: readonly unknown[];
}

export interface StudioGraphProviderContribution {
  readonly id: string;
  readonly project: (events: readonly StudioEvent[]) => StudioGraphProjection;
}

export interface StudioClientPlugin {
  readonly eventRenderers?: readonly StudioEventRendererContribution[] | undefined;
  readonly graphProviders?: readonly StudioGraphProviderContribution[] | undefined;
  readonly manifest: StudioPluginManifest;
  readonly navigation?: readonly StudioNavigationContribution[] | undefined;
  readonly pages?: readonly StudioPageContribution[] | undefined;
  readonly runActions?: readonly StudioRunActionContribution[] | undefined;
  readonly slots?: readonly StudioSlotContribution[] | undefined;
  readonly themeTokens?: Readonly<Record<`--${string}`, string>> | undefined;
}

export interface StudioClientRegistry {
  readonly eventRenderers: readonly (StudioEventRendererContribution & {
    readonly pluginId: string;
  })[];
  readonly graphProviders: readonly (StudioGraphProviderContribution & {
    readonly pluginId: string;
  })[];
  readonly navigation: readonly (StudioNavigationContribution & {
    readonly pluginId: string;
  })[];
  readonly pages: readonly (StudioPageContribution & {
    readonly pluginId: string;
  })[];
  readonly plugins: readonly StudioClientPlugin[];
  readonly runActions: readonly (StudioRunActionContribution & {
    readonly pluginId: string;
  })[];
  readonly slots: readonly (StudioSlotContribution & {
    readonly pluginId: string;
  })[];
  readonly themeTokens: Readonly<Record<`--${string}`, string>>;
}
