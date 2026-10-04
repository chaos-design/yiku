import { z } from "zod";
import type { ToolExecutionMiddleware } from "../common/middleware.js";
import type { WorkspaceContext } from "../common/workspace-context.js";

export const DEFAULT_FS_MAX_ENTRIES = 200;
export const DEFAULT_FS_MAX_RESULTS = 100;
export const DEFAULT_TREE_MAX_DEPTH = 3;

export interface FsOptions {
  readonly rootDir?: string | undefined;
  readonly workspace?: WorkspaceContext | undefined;
}

export interface FsListOptions extends FsOptions {
  readonly includeHidden?: boolean | undefined;
  readonly maxEntries?: number | undefined;
  readonly path?: string | undefined;
}

export interface FsTreeOptions extends FsOptions {
  readonly includeHidden?: boolean | undefined;
  readonly maxDepth?: number | undefined;
  readonly maxEntries?: number | undefined;
  readonly path?: string | undefined;
}

export interface FsGrepOptions extends FsOptions {
  readonly caseSensitive?: boolean | undefined;
  readonly includeHidden?: boolean | undefined;
  readonly maxResults?: number | undefined;
  readonly path?: string | undefined;
  readonly pattern: string;
}

export const fsListToolInputSchema = z.object({
  include_hidden: z.boolean().optional(),
  max_entries: z.number().int().positive().optional(),
  path: z.string().optional(),
});

export const fsTreeToolInputSchema = z.object({
  include_hidden: z.boolean().optional(),
  max_depth: z.number().int().nonnegative().optional(),
  max_entries: z.number().int().positive().optional(),
  path: z.string().optional(),
});

export const fsGrepToolInputSchema = z.object({
  case_sensitive: z.boolean().optional(),
  include_hidden: z.boolean().optional(),
  max_results: z.number().int().positive().optional(),
  path: z.string().optional(),
  pattern: z.string(),
});

export type FsListToolInput = z.infer<typeof fsListToolInputSchema>;
export type FsTreeToolInput = z.infer<typeof fsTreeToolInputSchema>;
export type FsGrepToolInput = z.infer<typeof fsGrepToolInputSchema>;

export interface FsToolOptions extends FsOptions {
  readonly description?: string | undefined;
  readonly middleware?: ToolExecutionMiddleware | undefined;
  readonly name?: string | undefined;
}
