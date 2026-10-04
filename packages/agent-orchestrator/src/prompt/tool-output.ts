import type { AgentInputItem } from "@openai/agents";
import { renderPromptReference } from "./context.js";

const PROMPT_CONTEXT_PREFIX = "<prompt-context ";

export function protectModelInputItems(items: readonly AgentInputItem[]): AgentInputItem[] {
  return items.map(protectModelInputItem);
}

function protectModelInputItem(item: AgentInputItem): AgentInputItem {
  switch (item.type) {
    case "function_call_result":
      return {
        ...item,
        output: protectFunctionOutput(item.output, item.name),
      };
    case "hosted_tool_call":
      return item.output === undefined
        ? item
        : {
            ...item,
            output: protectText(item.output, item.name),
          };
    case "shell_call_output":
      return {
        ...item,
        output: item.output.map((output) => ({
          ...output,
          stderr: protectText(output.stderr, "shell:stderr"),
          stdout: protectText(output.stdout, "shell:stdout"),
        })),
      };
    case "apply_patch_call_output":
      return item.output === undefined
        ? item
        : {
            ...item,
            output: protectText(item.output, "apply-patch"),
          };
    default:
      return item;
  }
}

function protectFunctionOutput(
  output: Extract<AgentInputItem, { type: "function_call_result" }>["output"],
  toolName: string,
): Extract<AgentInputItem, { type: "function_call_result" }>["output"] {
  if (typeof output === "string") {
    return protectText(output, toolName);
  }
  if (Array.isArray(output)) {
    return output.map((content) =>
      content.type === "input_text"
        ? {
            ...content,
            text: protectText(content.text, toolName),
          }
        : content,
    );
  }
  return output.type === "text"
    ? {
        ...output,
        text: protectText(output.text, toolName),
      }
    : output;
}

function protectText(value: string, sourceId: string): string {
  if (!value || value.startsWith(PROMPT_CONTEXT_PREFIX)) {
    return value;
  }
  return renderPromptReference({
    content: value,
    kind: "reference",
    source: "tool",
    sourceId,
    trust: "untrusted",
  });
}
