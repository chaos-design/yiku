import { tool } from "@openai/agents";
import { executeTool, type ToolCallMetadata } from "../common/middleware.js";
import { formatToolError } from "../common/output.js";
import { grepFiles } from "./grep.js";
import { listDirectory } from "./ls.js";
import { buildDirectoryTree } from "./tree.js";
import {
  type FsGrepToolInput,
  type FsListToolInput,
  type FsToolOptions,
  type FsTreeToolInput,
  fsGrepToolInputSchema,
  fsListToolInputSchema,
  fsTreeToolInputSchema,
} from "./types.js";

export function lsTool(options: FsToolOptions = {}) {
  const name = options.name ?? "lsTool";

  return tool({
    description: options.description ?? "List files and directories under the workspace.",
    errorFunction: (_context: unknown, error: unknown) => formatToolError(error),
    execute: (input: FsListToolInput, _context?: unknown, details?: ToolCallMetadata) =>
      executeTool(
        {
          ...(details?.toolCall?.callId !== undefined ? { callId: details.toolCall.callId } : {}),
          effect: "read",
          execute: (resolved) =>
            listDirectory({
              includeHidden: resolved.include_hidden,
              maxEntries: resolved.max_entries,
              path: resolved.path,
              ...(options.rootDir !== undefined ? { rootDir: options.rootDir } : {}),
              ...(options.workspace !== undefined ? { workspace: options.workspace } : {}),
            }),
          input,
          ...(details?.signal !== undefined ? { signal: details.signal } : {}),
          toolName: name,
          validate: (value) => fsListToolInputSchema.parse(value),
        },
        options.middleware,
      ),
    name,
    parameters: fsListToolInputSchema,
    strict: true,
  });
}

export function treeTool(options: FsToolOptions = {}) {
  const name = options.name ?? "treeTool";

  return tool({
    description: options.description ?? "Render a bounded directory tree under the workspace.",
    errorFunction: (_context: unknown, error: unknown) => formatToolError(error),
    execute: (input: FsTreeToolInput, _context?: unknown, details?: ToolCallMetadata) =>
      executeTool(
        {
          ...(details?.toolCall?.callId !== undefined ? { callId: details.toolCall.callId } : {}),
          effect: "read",
          execute: (resolved) =>
            buildDirectoryTree({
              includeHidden: resolved.include_hidden,
              maxDepth: resolved.max_depth,
              maxEntries: resolved.max_entries,
              path: resolved.path,
              ...(options.rootDir !== undefined ? { rootDir: options.rootDir } : {}),
              ...(options.workspace !== undefined ? { workspace: options.workspace } : {}),
            }),
          input,
          ...(details?.signal !== undefined ? { signal: details.signal } : {}),
          toolName: name,
          validate: (value) => fsTreeToolInputSchema.parse(value),
        },
        options.middleware,
      ),
    name,
    parameters: fsTreeToolInputSchema,
    strict: true,
  });
}

export function grepTool(options: FsToolOptions = {}) {
  const name = options.name ?? "grepTool";

  return tool({
    description:
      options.description ?? "Search text files under the workspace for a literal pattern.",
    errorFunction: (_context: unknown, error: unknown) => formatToolError(error),
    execute: (input: FsGrepToolInput, _context?: unknown, details?: ToolCallMetadata) =>
      executeTool(
        {
          ...(details?.toolCall?.callId !== undefined ? { callId: details.toolCall.callId } : {}),
          effect: "read",
          execute: (resolved) =>
            grepFiles({
              caseSensitive: resolved.case_sensitive,
              includeHidden: resolved.include_hidden,
              maxResults: resolved.max_results,
              path: resolved.path,
              pattern: resolved.pattern,
              ...(options.rootDir !== undefined ? { rootDir: options.rootDir } : {}),
              ...(options.workspace !== undefined ? { workspace: options.workspace } : {}),
            }),
          input,
          ...(details?.signal !== undefined ? { signal: details.signal } : {}),
          toolName: name,
          validate: (value) => fsGrepToolInputSchema.parse(value),
        },
        options.middleware,
      ),
    name,
    parameters: fsGrepToolInputSchema,
    strict: true,
  });
}
