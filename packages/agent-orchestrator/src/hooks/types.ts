import type { OperationEvent } from "@yiku/trajectory";

export interface HookContext {
  readonly sessionId?: string | undefined;
}

/**
 * @deprecated Use @yiku/hooks lifecycle handlers.
 */
export interface Hook {
  readonly fatal?: boolean | undefined;
  readonly name: string;
  readonly onOperation: (event: OperationEvent, context: HookContext) => void | Promise<void>;
}

/**
 * @deprecated Use @yiku/hooks HookCallback.
 */
export type OperationHook = Hook["onOperation"];
