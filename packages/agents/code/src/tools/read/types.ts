import { z } from "zod";
import type { ToolExecutionMiddleware } from "../common/middleware.js";
import type { WorkspaceContext } from "../common/workspace-context.js";

export const readToolInputSchema = z
  .object({
    file_path: z.string().trim().min(1),
    line_end: z.number().int().optional(),
    line_start: z.number().int().min(1).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const lineStart = input.line_start ?? 1;
    if (input.line_end !== undefined && input.line_end !== -1 && input.line_end < lineStart) {
      context.addIssue({
        code: "custom",
        message: "line_end must be -1 or greater than or equal to line_start.",
        path: ["line_end"],
      });
    }
  });

export type ReadToolInput = z.infer<typeof readToolInputSchema>;

export interface TextReadOperationInput {
  readonly filePath: string;
  readonly lineEnd?: number | undefined;
  readonly lineStart?: number | undefined;
}

export interface TextReadOperationResult {
  readonly content: string;
  readonly filePath: string;
  readonly startLine: number;
}

export interface ReadToolExecutor {
  readonly read: (input: TextReadOperationInput) => Promise<TextReadOperationResult>;
}

export interface ReadToolOptions {
  readonly description?: string | undefined;
  readonly executor?: ReadToolExecutor | undefined;
  readonly maxCharacters?: number | undefined;
  readonly middleware?: ToolExecutionMiddleware | undefined;
  readonly name?: string | undefined;
  readonly rootDir?: string | undefined;
  readonly workspace?: WorkspaceContext | undefined;
}
