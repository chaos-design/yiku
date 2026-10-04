import { z } from "zod";
import { HookProtocolError } from "../errors.js";
import type { HookEventName, HookHandlerOutput } from "../types.js";
import { jsonObjectSchema, jsonValueSchema } from "./event-schema.js";
import { getHookEventCapability } from "./manifest.js";

const permissionUpdateSchema = z
  .object({
    decision: z.enum(["allow", "ask", "deny"]),
    destination: z.string().optional(),
    rule: z.string().optional(),
  })
  .strict();

const hookSpecificOutputSchema = z
  .object({
    additionalContext: z.string().optional(),
    hookEventName: z.string().min(1),
    permissionDecision: z.enum(["allow", "deny", "ask"]).optional(),
    permissionDecisionReason: z.string().optional(),
    result: jsonValueSchema.optional(),
    updatedInput: jsonObjectSchema.optional(),
    updatedValue: jsonValueSchema.optional(),
  })
  .strict();

export const hookHandlerOutputSchema = z
  .object({
    action: z.enum(["allow", "block", "defer", "no-op", "stop"]).optional(),
    additionalContext: z.union([z.string(), z.array(z.string())]).optional(),
    continue: z.boolean().optional(),
    decision: z.enum(["allow", "block"]).optional(),
    hookSpecificOutput: hookSpecificOutputSchema.optional(),
    permissionUpdates: z.array(permissionUpdateSchema).optional(),
    reason: z.string().optional(),
    stopReason: z.string().optional(),
    suppressOutput: z.boolean().optional(),
    systemMessage: z.string().optional(),
    updatedInput: jsonObjectSchema.optional(),
  })
  .strict();

export function parseHookHandlerOutput(
  eventName: HookEventName,
  value: unknown,
): HookHandlerOutput {
  try {
    const output = hookHandlerOutputSchema.parse(value);
    validateOutputCapabilities(eventName, output);
    return output as HookHandlerOutput;
  } catch (error) {
    if (error instanceof HookProtocolError) {
      throw error;
    }

    throw new HookProtocolError(
      "HOOK_PROTOCOL_INVALID",
      `Hook output is invalid for ${eventName}.`,
      {
        cause: error,
        eventName,
      },
    );
  }
}

function validateOutputCapabilities(
  eventName: HookEventName,
  output: z.output<typeof hookHandlerOutputSchema>,
): void {
  const capability = getHookEventCapability(eventName);
  const specificEventName = output.hookSpecificOutput?.hookEventName;

  if (specificEventName !== undefined && specificEventName !== eventName) {
    protocolError(eventName, "hookSpecificOutput.hookEventName must match the input event.");
  }

  if (
    (output.updatedInput !== undefined ||
      output.hookSpecificOutput?.updatedInput !== undefined ||
      output.hookSpecificOutput?.updatedValue !== undefined) &&
    !capability.decisions.includes("modify")
  ) {
    protocolError(eventName, `${eventName} does not support output modification.`);
  }

  if (
    (output.additionalContext !== undefined ||
      output.hookSpecificOutput?.additionalContext !== undefined) &&
    !capability.decisions.includes("context")
  ) {
    protocolError(eventName, `${eventName} does not support additional context.`);
  }

  const action = output.action ?? (output.decision === "block" ? "block" : undefined);

  if (action === "block" && !capability.decisions.includes("block")) {
    protocolError(eventName, `${eventName} does not support blocking decisions.`);
  }

  if (action === "defer" && !capability.decisions.includes("defer")) {
    protocolError(eventName, `${eventName} does not support deferred decisions.`);
  }

  if (action === "stop" && !capability.decisions.includes("stop")) {
    protocolError(eventName, `${eventName} does not support stop decisions.`);
  }

  if (
    output.hookSpecificOutput?.permissionDecision !== undefined &&
    eventName !== "PermissionRequest" &&
    eventName !== "PreToolUse"
  ) {
    protocolError(eventName, "permissionDecision is only valid for tool permission events.");
  }
}

function protocolError(eventName: HookEventName, message: string): never {
  throw new HookProtocolError("HOOK_PROTOCOL_INVALID", message, {
    eventName,
  });
}
