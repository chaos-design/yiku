import { type HostedTool, webSearchTool } from "@openai/agents";

export type SearchContextSize = "high" | "low" | "medium";

export function createResearchWebSearchTool(searchContextSize?: SearchContextSize): HostedTool {
  const tool =
    searchContextSize === undefined
      ? webSearchTool()
      : webSearchTool({
          searchContextSize,
        });

  if (searchContextSize === undefined) {
    // The SDK injects "medium" by default, but some compatible providers reject the field.
    delete (tool.providerData as { search_context_size?: unknown }).search_context_size;
  }

  return tool;
}
