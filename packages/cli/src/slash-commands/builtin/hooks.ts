import {
  HOOKS_USAGE,
  presentHookDryRun,
  presentHookInspection,
  presentHookList,
  presentRecentHookEvents,
} from "../../hooks/presentation.js";
import type { LocalSlashCommand, SlashCommandResult } from "../types.js";

export const hooksCommand: LocalSlashCommand = {
  kind: "local",
  description: "Inspect and manage Hooks",
  execute: async (context, arguments_) => {
    const controller = await context.getHookController();
    if (controller === undefined) {
      return error("Hook management is unavailable in this session.");
    }

    const [action, hookId, ...extra] = arguments_.values;
    if (action === undefined) {
      const entries = await controller.list();
      return success(`${presentHookList(entries)}\n\n${HOOKS_USAGE}`);
    }
    if (extra.length > 0) {
      return error(`Too many /hooks arguments.\n\n${HOOKS_USAGE}`);
    }

    try {
      switch (action) {
        case "list":
          return hookId === undefined
            ? success(presentHookList(await controller.list()))
            : error("Usage: /hooks list");
        case "inspect":
          return hookId === undefined
            ? error("Usage: /hooks inspect <hookId>")
            : success(presentHookInspection(await controller.inspect(hookId)));
        case "trust":
          return hookId === undefined
            ? error("Usage: /hooks trust <hookId>")
            : success(
                `Trusted ${hookId}.\n${presentHookInspection(await controller.trust(hookId))}`,
              );
        case "revoke":
          return hookId === undefined
            ? error("Usage: /hooks revoke <hookId>")
            : success(
                `Revoked trust for ${hookId}.\n${presentHookInspection(
                  await controller.revoke(hookId),
                )}`,
              );
        case "enable":
          return hookId === undefined
            ? error("Usage: /hooks enable <hookId>")
            : success(
                `Enabled ${hookId}.\n${presentHookInspection(await controller.enable(hookId))}`,
              );
        case "disable":
          return hookId === undefined
            ? error("Usage: /hooks disable <hookId>")
            : success(
                `Disabled ${hookId}.\n${presentHookInspection(await controller.disable(hookId))}`,
              );
        case "dry-run":
          return hookId === undefined
            ? error("Usage: /hooks dry-run <hookId>")
            : success(presentHookDryRun(await controller.dryRun(hookId)));
        case "recent":
          return hookId === undefined
            ? success(presentRecentHookEvents(controller.recent()))
            : error("Usage: /hooks recent");
        default:
          return error(`Unknown /hooks action: ${action}.\n\n${HOOKS_USAGE}`);
      }
    } catch (commandError) {
      return error(commandError instanceof Error ? commandError.message : String(commandError));
    }
  },
  name: "hooks",
  source: "builtin",
};

function success(message: string): SlashCommandResult {
  return {
    kind: "success",
    message,
    title: "Hooks",
  };
}

function error(message: string): SlashCommandResult {
  return {
    kind: "error",
    message,
    title: "Command Error",
  };
}
