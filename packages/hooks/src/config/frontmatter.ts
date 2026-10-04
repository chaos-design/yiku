import { parseDocument } from "yaml";
import { HookConfigError } from "../errors.js";
import type { HookSourceType } from "../types.js";

export function parseHookFrontmatter(
  content: string,
  options: {
    readonly componentId: string;
    readonly sourceType: Extract<HookSourceType, "agent" | "skill">;
  },
): unknown | undefined {
  const lines = content.replaceAll("\r\n", "\n").split("\n");

  if (lines[0]?.trim() !== "---") {
    return undefined;
  }

  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");

  if (closingIndex === -1) {
    throw configError(options, "Hook component frontmatter is not closed.");
  }

  const document = parseDocument(lines.slice(1, closingIndex).join("\n"), {
    prettyErrors: false,
    strict: true,
  });

  if (document.errors.length > 0) {
    throw configError(options, "Hook component frontmatter is invalid YAML.", document.errors[0]);
  }

  const value: unknown = document.toJS({
    maxAliasCount: 0,
  });

  if (!isRecord(value) || value.hooks === undefined) {
    return undefined;
  }

  return {
    hooks: value.hooks,
  };
}

function configError(
  options: {
    readonly componentId: string;
    readonly sourceType: Extract<HookSourceType, "agent" | "skill">;
  },
  message: string,
  cause?: unknown,
): HookConfigError {
  return new HookConfigError("HOOK_CONFIG_INVALID", message, {
    ...(cause !== undefined ? { cause } : {}),
    sourceType: options.sourceType,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
