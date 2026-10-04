import { resolve } from "node:path";
import { loadMarkdownPromptTemplate, renderPromptTemplate } from "./prompt-template.js";

const CODE_AGENT_PROMPT_TEMPLATE_NAME = "code";
const FALLBACK_CODE_AGENT_PROMPT_TEMPLATE = "{{prompt}}";

export const DEFAULT_CODE_AGENT_PROMPT_TEMPLATE = loadCodeAgentPromptTemplate();

export interface RenderCodeAgentPromptOptions {
  readonly instructions?: string | undefined;
  readonly prompt: string;
  readonly template?: string | undefined;
  readonly workspaceDir?: string | undefined;
}

export function renderCodeAgentPrompt(options: RenderCodeAgentPromptOptions): string {
  const workspaceDir = resolve(options.workspaceDir?.trim() || process.cwd());

  return renderPromptTemplate({
    template: options.template ?? DEFAULT_CODE_AGENT_PROMPT_TEMPLATE,
    variables: {
      instructions: options.instructions ?? "",
      prompt: options.prompt,
      workspaceDir,
    },
  });
}

export function loadCodeAgentPromptTemplate(templateUrls?: readonly URL[]): string {
  return loadMarkdownPromptTemplate({
    fallbackTemplate: FALLBACK_CODE_AGENT_PROMPT_TEMPLATE,
    templateName: CODE_AGENT_PROMPT_TEMPLATE_NAME,
    ...(templateUrls !== undefined ? { templateUrls } : {}),
  });
}
