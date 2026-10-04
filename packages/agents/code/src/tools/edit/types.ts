import { z } from "zod";
import type { ToolExecutionMiddleware } from "../common/middleware.js";
import type { WorkspaceContext } from "../common/workspace-context.js";

export const TEXT_EDITOR_TOOL_DEFINITION = {
  max_characters: 20_000,
  name: "textEditorTool",
  type: "text_editor_20250728",
} as const;

export const DEFAULT_TEXT_EDITOR_MAX_CHARACTERS = 20_000;
export const TEXT_EDITOR_COMMANDS = ["view", "str_replace", "create", "insert"] as const;

const legacyViewSchema = z
  .object({
    command: z.literal("view"),
    path: z.string().trim().min(1),
    view_range: z.union([z.tuple([]), z.tuple([z.number().int(), z.number().int()])]).optional(),
  })
  .passthrough();

const legacyStrReplaceSchema = z
  .object({
    command: z.literal("str_replace"),
    new_str: z.string().optional(),
    old_str: z.string().optional(),
    path: z.string().trim().min(1),
  })
  .passthrough();

const legacyCreateSchema = z
  .object({
    command: z.literal("create"),
    file_text: z.string().optional(),
    path: z.string().trim().min(1),
  })
  .passthrough();

const legacyInsertSchema = z
  .object({
    command: z.literal("insert"),
    insert_line: z.number().int().optional(),
    insert_text: z.string().optional(),
    path: z.string().trim().min(1),
  })
  .passthrough();

export const textEditorToolInputSchema = z.object({
  command: z.enum(TEXT_EDITOR_COMMANDS),
  file_text: z.string().optional(),
  insert_line: z.number().int().optional(),
  insert_text: z.string().optional(),
  new_str: z.string().optional(),
  old_str: z.string().optional(),
  path: z.string().trim().min(1),
  view_range: z.union([z.tuple([]), z.tuple([z.number().int(), z.number().int()])]).optional(),
});

export const textEditorReadOnlyInputSchema = legacyViewSchema;

export type TextEditorToolInput =
  | {
      readonly command: "view";
      readonly path: string;
      readonly view_range?: readonly [number, number] | undefined;
    }
  | {
      readonly command: "str_replace";
      readonly new_str?: string | undefined;
      readonly old_str?: string | undefined;
      readonly path: string;
    }
  | {
      readonly command: "create";
      readonly file_text?: string | undefined;
      readonly path: string;
    }
  | {
      readonly command: "insert";
      readonly insert_line?: number | undefined;
      readonly insert_text?: string | undefined;
      readonly path: string;
    };

export function parseTextEditorToolInput(input: unknown): TextEditorToolInput {
  const adapterInput = textEditorToolInputSchema.parse(input);

  switch (adapterInput.command) {
    case "view": {
      const parsed = legacyViewSchema.parse(input);
      return {
        command: parsed.command,
        path: parsed.path,
        ...(parsed.view_range?.length === 2 ? { view_range: parsed.view_range } : {}),
      };
    }
    case "str_replace": {
      const parsed = legacyStrReplaceSchema.parse(input);
      return {
        command: parsed.command,
        ...(parsed.new_str !== undefined ? { new_str: parsed.new_str } : {}),
        ...(parsed.old_str !== undefined ? { old_str: parsed.old_str } : {}),
        path: parsed.path,
      };
    }
    case "create": {
      const parsed = legacyCreateSchema.parse(input);
      return {
        command: parsed.command,
        ...(parsed.file_text !== undefined ? { file_text: parsed.file_text } : {}),
        path: parsed.path,
      };
    }
    case "insert": {
      const parsed = legacyInsertSchema.parse(input);
      return {
        command: parsed.command,
        ...(parsed.insert_line !== undefined ? { insert_line: parsed.insert_line } : {}),
        ...(parsed.insert_text !== undefined ? { insert_text: parsed.insert_text } : {}),
        path: parsed.path,
      };
    }
  }
}

export const editToolInputSchema = z
  .object({
    file_path: z.string().trim().min(1),
    new_string: z.string(),
    old_string: z.string().min(1),
    replace_all: z.boolean(),
  })
  .strict();

export const writeToolInputSchema = z
  .object({
    content: z.string(),
    file_path: z.string().trim().min(1),
  })
  .strict();

export type EditToolInput = z.infer<typeof editToolInputSchema>;
export type WriteToolInput = z.infer<typeof writeToolInputSchema>;

export type TextFileWriteType = "add" | "update";

export interface TextFileDiffDisplay {
  readonly filePath: string;
  readonly newText: string;
  readonly oldText: string;
  readonly startLine: number;
  readonly type: "diff";
  readonly writeType: TextFileWriteType;
}

export interface TextEditOperationInput {
  readonly filePath: string;
  readonly newText: string;
  readonly oldText: string;
  readonly replaceAll?: boolean | undefined;
}

export interface TextEditOperationResult {
  readonly filePath: string;
  readonly matchCount: number;
  readonly newText: string;
  readonly oldText: string;
  readonly startLine: number;
}

export interface TextWriteOperationInput {
  readonly content: string;
  readonly filePath: string;
}

export interface TextWriteOperationResult {
  readonly filePath: string;
  readonly newText: string;
  readonly oldText: string;
  readonly writeType: "create" | "replace";
}

export interface TextEditorToolExecutor {
  readonly execute: (input: TextEditorToolInput) => Promise<string>;
}

export interface EditToolExecutor {
  readonly edit: (input: TextEditOperationInput) => Promise<TextEditOperationResult>;
}

export interface WriteToolExecutor {
  readonly write: (input: TextWriteOperationInput) => Promise<TextWriteOperationResult>;
}

export interface TextEditorOptions {
  readonly maxCharacters?: number | undefined;
  readonly readOnly?: boolean | undefined;
  readonly rootDir?: string | undefined;
  readonly workspace?: WorkspaceContext | undefined;
}

export interface TextEditorToolOptions extends TextEditorOptions {
  readonly description?: string | undefined;
  readonly executor?: TextEditorToolExecutor | undefined;
  readonly middleware?: ToolExecutionMiddleware | undefined;
  readonly name?: string | undefined;
}

export interface EditToolOptions extends TextEditorOptions {
  readonly description?: string | undefined;
  readonly executor?: EditToolExecutor | undefined;
  readonly middleware?: ToolExecutionMiddleware | undefined;
  readonly name?: string | undefined;
}

export interface WriteToolOptions extends TextEditorOptions {
  readonly description?: string | undefined;
  readonly executor?: WriteToolExecutor | undefined;
  readonly middleware?: ToolExecutionMiddleware | undefined;
  readonly name?: string | undefined;
}
