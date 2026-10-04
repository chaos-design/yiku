import { codeTool } from "../common/definition.js";
import { toolExecutionErrorResult } from "../common/errors.js";
import { TextFileOperations } from "./text-editor.js";
import {
  type EditToolInput,
  type EditToolOptions,
  editToolInputSchema,
  type TextFileDiffDisplay,
} from "./types.js";

export function editTool(options: EditToolOptions = {}) {
  const executor = options.executor ?? new TextFileOperations(options);

  return codeTool<EditToolInput, TextFileDiffDisplay>({
    description:
      options.description ??
      "Replace exact text in a file. The match must be unique unless replace_all is true.",
    effect: "write",
    execute: async (input) => {
      try {
        const result = await executor.edit({
          filePath: input.file_path,
          newText: input.new_string,
          oldText: input.old_string,
          replaceAll: input.replace_all,
        });

        return {
          display: {
            filePath: result.filePath,
            newText: result.newText,
            oldText: result.oldText,
            startLine: result.startLine,
            type: "diff",
            writeType: "update",
          },
          isError: false,
          llmContent: `File ${result.filePath} successfully edited.`,
          metadata: {
            filePath: result.filePath,
            matchCount: result.matchCount,
          },
        };
      } catch (error) {
        return toolExecutionErrorResult(error);
      }
    },
    middleware: options.middleware,
    name: options.name ?? "editTool",
    parameters: editToolInputSchema,
  });
}
