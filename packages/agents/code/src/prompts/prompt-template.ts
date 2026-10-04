import { existsSync, readFileSync } from "node:fs";
import { requireNonEmpty } from "../tools/common/validation.js";

const TEMPLATE_VARIABLE_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
const TEMPLATE_FILE_NAME_PATTERN = /^[a-z0-9-]+(?:\.md)?$/;

export type PromptTemplateVariables = Record<string, string | undefined>;

export interface LoadMarkdownPromptTemplateOptions {
  readonly fallbackTemplate: string;
  readonly templateName: string;
  readonly templateUrls?: readonly URL[] | undefined;
}

export interface RenderPromptTemplateOptions {
  readonly template: string;
  readonly variables: PromptTemplateVariables;
}

export interface RenderMarkdownPromptTemplateOptions {
  readonly fallbackTemplate: string;
  readonly templateName: string;
  readonly templateUrls?: readonly URL[] | undefined;
  readonly variables: PromptTemplateVariables;
}

export function createPromptTemplateUrls(templateName: string): readonly URL[] {
  const templateFileName = resolveTemplateFileName(templateName);

  return [
    new URL(`./templates/${templateFileName}`, import.meta.url),
    new URL(`../../src/prompts/templates/${templateFileName}`, import.meta.url),
  ];
}

export function loadMarkdownPromptTemplate(options: LoadMarkdownPromptTemplateOptions): string {
  const fallbackTemplate = requireNonEmpty(
    options.fallbackTemplate,
    "Fallback prompt template is required.",
  );
  const templateUrls = options.templateUrls ?? createPromptTemplateUrls(options.templateName);

  for (const templateUrl of templateUrls) {
    if (!existsSync(templateUrl)) {
      continue;
    }

    const template = readFileSync(templateUrl, "utf8").trim();

    if (template) {
      return template;
    }
  }

  return fallbackTemplate;
}

export function renderMarkdownPromptTemplate(options: RenderMarkdownPromptTemplateOptions): string {
  return renderPromptTemplate({
    template: loadMarkdownPromptTemplate({
      fallbackTemplate: options.fallbackTemplate,
      templateName: options.templateName,
      ...(options.templateUrls !== undefined ? { templateUrls: options.templateUrls } : {}),
    }),
    variables: options.variables,
  });
}

export function renderPromptTemplate(options: RenderPromptTemplateOptions): string {
  const template = requireNonEmpty(options.template, "Prompt template is required.");
  const missingVariables = new Set<string>();
  const rendered = template.replace(TEMPLATE_VARIABLE_PATTERN, (match, variableName: string) => {
    const value = options.variables[variableName];

    if (value === undefined) {
      missingVariables.add(variableName);

      return match;
    }

    return value;
  });

  if (missingVariables.size > 0) {
    throw new Error(
      `Prompt template is missing required variables: ${[...missingVariables].join(", ")}.`,
    );
  }

  return rendered.trim();
}

function resolveTemplateFileName(templateName: string): string {
  const normalizedTemplateName = requireNonEmpty(templateName, "Prompt template name is required.");

  if (!TEMPLATE_FILE_NAME_PATTERN.test(normalizedTemplateName)) {
    throw new Error(
      "Prompt template name must contain only lowercase letters, numbers, and hyphens.",
    );
  }

  return normalizedTemplateName.endsWith(".md")
    ? normalizedTemplateName
    : `${normalizedTemplateName}.md`;
}
