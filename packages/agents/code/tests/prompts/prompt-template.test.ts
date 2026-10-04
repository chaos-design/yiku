import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPromptTemplateUrls,
  loadCodeAgentPromptTemplate,
  loadMarkdownPromptTemplate,
  renderCodeAgentPrompt,
  renderMarkdownPromptTemplate,
  renderPromptTemplate,
} from "../../src/index.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("prompt templates", () => {
  it("renders prompt templates and validates missing variables", () => {
    expect(
      renderPromptTemplate({
        template: "Hello {{ name }}",
        variables: {
          name: "Yiku",
        },
      }),
    ).toBe("Hello Yiku");

    expect(() =>
      renderPromptTemplate({
        template: "Hello {{ name }}",
        variables: {},
      }),
    ).toThrow("Prompt template is missing required variables: name.");
  });

  it("loads markdown templates with fallback behavior", () => {
    const dir = mkdtempSync(join(tmpdir(), "yiku-template-"));
    tempDirs.push(dir);
    const emptyTemplateUrl = pathToFileURL(join(dir, "empty.md"));
    const templateUrl = pathToFileURL(join(dir, "custom.md"));

    writeFileSync(emptyTemplateUrl, "");
    writeFileSync(templateUrl, "Hello {{name}}\n");

    expect(
      loadMarkdownPromptTemplate({
        fallbackTemplate: "fallback",
        templateName: "custom",
        templateUrls: [emptyTemplateUrl, templateUrl],
      }),
    ).toBe("Hello {{name}}");
    expect(
      renderMarkdownPromptTemplate({
        fallbackTemplate: "Hello {{name}}",
        templateName: "missing",
        templateUrls: [],
        variables: {
          name: "Yiku",
        },
      }),
    ).toBe("Hello Yiku");
  });

  it("validates template names and renders code agent prompts", () => {
    expect(createPromptTemplateUrls("code")[0]?.pathname.endsWith("/code.md")).toBe(true);
    expect(createPromptTemplateUrls("code.md")[0]?.pathname.endsWith("/code.md")).toBe(true);
    expect(() => createPromptTemplateUrls("../bad")).toThrow(
      "Prompt template name must contain only lowercase letters, numbers, and hyphens.",
    );
    expect(() => createPromptTemplateUrls("")).toThrow("Prompt template name is required.");
    expect(loadCodeAgentPromptTemplate([])).toBe("{{prompt}}");
    expect(
      renderCodeAgentPrompt({
        instructions: "Follow instructions.",
        prompt: "Review this",
        template: "{{workspaceDir}}\n{{instructions}}\n{{prompt}}",
        workspaceDir: "/tmp/project",
      }),
    ).toContain("Review this");
  });

  it("requires option-based questions to resume the same run", () => {
    const template = loadCodeAgentPromptTemplate();

    expect(template).toContain("invoke `AskUserQuestion`");
    expect(template).toContain("exactly one top-level field");
    expect(template).toContain("structured `questions` array");
    expect(template).toContain("2-4 options with useful descriptions");
    expect(template).toContain("continue the same run");
  });
});
