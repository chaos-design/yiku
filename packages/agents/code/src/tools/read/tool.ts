import { codeTool } from "../common/definition.js";
import { toolExecutionErrorResult } from "../common/errors.js";
import { TextFileOperations } from "../edit/text-editor.js";
import { type ReadToolInput, type ReadToolOptions, readToolInputSchema } from "./types.js";

export function readTool(options: ReadToolOptions = {}) {
  const executor = options.executor ?? new TextFileOperations(options);

  return codeTool({
    description:
      options.description ??
      "Read a text file with line numbers. line_end may be -1 to read through the end.",
    effect: "read",
    execute: async (input: ReadToolInput) => {
      try {
        const result = await executor.read({
          filePath: input.file_path,
          ...(input.line_end !== undefined ? { lineEnd: input.line_end } : {}),
          ...(input.line_start !== undefined ? { lineStart: input.line_start } : {}),
        });

        return {
          isError: false,
          llmContent: result.content,
          metadata: {
            filePath: result.filePath,
            startLine: result.startLine,
          },
        };
      } catch (error) {
        return toolExecutionErrorResult(error);
      }
    },
    middleware: options.middleware,
    name: options.name ?? "readTool",
    parameters: readToolInputSchema,
  });
}
