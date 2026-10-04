import type { MemorySearchClass } from "@yiku/memories";
import type { LocalSlashCommand, SlashCommandResult } from "../types.js";

const MEMORY_CLASSES = new Set<MemorySearchClass>(["working", "semantic", "procedure", "scenario"]);

export const memoryCommand: LocalSlashCommand = {
  kind: "local",
  description: "Search and manage Agent Memory",
  execution: "idle",
  execute: async (context, arguments_) => {
    const controller = await context.getMemoryController();
    if (controller === undefined) {
      return error("Memory is disabled or unavailable.");
    }

    const [subcommand, ...values] = arguments_.values;
    switch (subcommand) {
      case "status": {
        if (values.length > 0) {
          return usage();
        }
        const status = await controller.status();
        return success(
          [
            `Working: ${status.working}`,
            `Pending consolidation: ${status.pendingConsolidation}`,
            `Semantic: ${status.longTerm.semantic}`,
            `Procedure: ${status.longTerm.procedure}`,
            `Scenario: ${status.longTerm.scenario}`,
          ].join("\n"),
        );
      }
      case "search": {
        const parsed = parseSearch(values);
        if ("error" in parsed) {
          return error(parsed.error);
        }
        const results = await controller.search(parsed.query, {
          ...(parsed.memoryClass !== undefined ? { classes: [parsed.memoryClass] } : {}),
        });
        return success(
          results.length === 0
            ? "No matching memories."
            : results
                .map(
                  (result) =>
                    `${result.tier === "working" ? result.workingMemory.id : result.memory.id} ` +
                    `[${result.class}] ${result.score.toFixed(3)} ${singleLine(result.content)}`,
                )
                .join("\n"),
        );
      }
      case "consolidate": {
        if (values.length > 0) {
          return usage();
        }
        const result = await controller.consolidate();
        return success(
          [
            `Consolidated: ${result.consolidated}`,
            `Discarded: ${result.discarded}`,
            `Pending: ${result.pending}`,
            `Failed: ${result.failed}`,
          ].join("\n"),
        );
      }
      case "forget": {
        const hard = values[0] === "--hard";
        const id = hard ? values[1] : values[0];
        if (!id || values.length !== (hard ? 2 : 1)) {
          return usage();
        }
        const result = await controller.forget(id, hard);
        return success(
          result.forgotten
            ? `Forgot ${result.id} (${result.tier}, ${result.mode}).`
            : `Memory not found: ${result.id}.`,
        );
      }
      default:
        return usage();
    }
  },
  name: "memory",
  source: "builtin",
};

function parseSearch(
  values: readonly string[],
):
  | { readonly memoryClass?: MemorySearchClass | undefined; readonly query: string }
  | { readonly error: string } {
  let memoryClass: MemorySearchClass | undefined;
  const query: string[] = [];

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value !== "--class") {
      query.push(value as string);
      continue;
    }
    const candidate = values[index + 1] as MemorySearchClass | undefined;
    if (candidate === undefined || !MEMORY_CLASSES.has(candidate)) {
      return { error: "Memory class must be working, semantic, procedure, or scenario." };
    }
    memoryClass = candidate;
    index += 1;
  }

  const normalizedQuery = query.join(" ").trim();
  return normalizedQuery
    ? { ...(memoryClass !== undefined ? { memoryClass } : {}), query: normalizedQuery }
    : { error: "Usage: /memory search [--class <class>] <query>" };
}

function singleLine(value: string): string {
  const normalized = value.replaceAll(/\s+/gu, " ").trim();
  return normalized.length <= 200 ? normalized : `${normalized.slice(0, 197)}...`;
}

function success(message: string): SlashCommandResult {
  return { kind: "success", message, title: "Memory" };
}

function error(message: string): SlashCommandResult {
  return { kind: "error", message, title: "Command Error" };
}

function usage(): SlashCommandResult {
  return error(
    "Usage: /memory status | search [--class <class>] <query> | consolidate | forget [--hard] <id>",
  );
}
