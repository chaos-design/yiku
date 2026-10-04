import { codeTool } from "../common/definition.js";
import { toolExecutionErrorResult } from "../common/errors.js";
import { TextFileOperations } from "./text-editor.js";
import {
  type TextFileDiffDisplay,
  type WriteToolInput,
  type WriteToolOptions,
  writeToolInputSchema,
} from "./types.js";

export function writeTool(options: WriteToolOptions = {}) {
  const executor = options.executor ?? new TextFileOperations(options);

  return codeTool<WriteToolInput, TextFileDiffDisplay>({
    description:
      options.description ??
      "Atomically create or replace a text file. The written content always ends with a newline.",
    effect: "write",
    execute: async (input) => {
      try {
        const result = await executor.write({
          content: input.content,
          filePath: input.file_path,
        });

        return {
          display: {
            filePath: result.filePath,
            newText: result.newText,
            oldText: result.oldText,
            startLine: 1,
            type: "diff",
            writeType: result.writeType === "create" ? "add" : "update",
          },
          isError: false,
          llmContent: `File ${result.filePath} successfully written.`,
          metadata: {
            filePath: result.filePath,
            writeType: result.writeType,
          },
        };
      } catch (error) {
        return toolExecutionErrorResult(error);
      }
    },
    middleware: options.middleware,
    name: options.name ?? "writeTool",
    parameters: writeToolInputSchema,
  });
}
