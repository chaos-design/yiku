import { tool } from "@openai/agents";
import { executeTool, type ToolCallMetadata } from "../common/middleware.js";
import { formatToolError } from "../common/output.js";
import { TextEditor } from "./text-editor.js";
import {
  parseTextEditorToolInput,
  TEXT_EDITOR_TOOL_DEFINITION,
  type TextEditorToolOptions,
} from "./types.js";

type OpenAITextEditorSchema = {
  additionalProperties: true;
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  type: "object";
};

const textEditorToolParameters: OpenAITextEditorSchema = {
  additionalProperties: true,
  properties: {
    command: {
      enum: ["view", "str_replace", "create", "insert"],
      type: "string",
    },
    file_text: { type: "string" },
    insert_line: { type: "integer" },
    insert_text: { type: "string" },
    new_str: { type: "string" },
    old_str: { type: "string" },
    path: { type: "string" },
    view_range: {
      items: { type: "integer" },
      maxItems: 2,
      type: "array",
    },
  },
  required: ["command", "path"],
  type: "object",
};

export function textEditorTool(options: TextEditorToolOptions = {}) {
  const executor = options.executor ?? new TextEditor(options);
  const name = options.name ?? TEXT_EDITOR_TOOL_DEFINITION.name;

  return tool({
    description:
      options.description ??
      "View and edit text files with view, create, str_replace, and insert. Write access may require user approval.",
    errorFunction: (_context: unknown, error: unknown) => formatToolError(error),
    execute: (input, _context?: unknown, details?: ToolCallMetadata) => {
      const normalizedInput = parseTextEditorToolInput(input);

      return executeTool(
        {
          ...(details?.toolCall?.callId !== undefined ? { callId: details.toolCall.callId } : {}),
          effect: normalizedInput.command === "view" ? "read" : "write",
          execute: (resolved) => executor.execute(resolved),
          input: normalizedInput,
          ...(details?.signal !== undefined ? { signal: details.signal } : {}),
          toolName: name,
          validate: parseTextEditorToolInput,
        },
        options.middleware,
      );
    },
    name,
    parameters: textEditorToolParameters,
    strict: false,
  });
}
