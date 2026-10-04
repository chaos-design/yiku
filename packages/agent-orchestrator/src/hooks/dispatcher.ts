import type { OperationEvent } from "@yiku/trajectory";
import { OperationHookAdapter } from "./operation-adapter.js";
import type { Hook, HookContext } from "./types.js";

/**
 * @deprecated Use OperationHookAdapter during migration to @yiku/hooks.
 */
export async function dispatchHooks(
  hooks: readonly Hook[],
  event: OperationEvent,
  context: HookContext = {},
): Promise<void> {
  await new OperationHookAdapter(hooks).notify(event, context);
}
