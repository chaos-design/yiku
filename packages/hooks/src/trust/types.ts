import type { HookTrustApprovalHandler } from "../types.js";
import type { HookTrustDescriptor } from "./canonical.js";

export interface HookTrustEntry {
  readonly approvedAt: string;
  readonly descriptor: HookTrustDescriptor;
  readonly key: string;
}

export interface HookTrustDocument {
  readonly entries: readonly HookTrustEntry[];
  readonly version: 1;
}

export interface HookTrustStoreOptions {
  readonly filePath: string;
  readonly now?: (() => Date) | undefined;
}

export interface HookTrustPolicyOptions {
  readonly allowManagedHooksOnly?: boolean | undefined;
  readonly allowOpaqueShell?: boolean | undefined;
  readonly approvalHandler?: HookTrustApprovalHandler | undefined;
  readonly managedHooksTrusted?: boolean | undefined;
  readonly store: HookTrustStoreContract;
}

export interface HookTrustStoreContract {
  approve(descriptor: HookTrustDescriptor): Promise<HookTrustEntry>;
  has(descriptor: HookTrustDescriptor): Promise<boolean>;
  list(): Promise<readonly HookTrustEntry[]>;
  revoke(key: string): Promise<boolean>;
}

export interface HookTrustResult {
  readonly key: string;
  readonly reason: string;
  readonly trusted: boolean;
}
