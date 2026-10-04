import { describe, expect, it } from "vitest";
import { DEFAULT_RESEARCH_PROMPT, loadResearchPrompt } from "../../src/prompts/research-prompt.js";

describe("Research prompt", () => {
  it("loads the professional evidence research template", () => {
    expect(DEFAULT_RESEARCH_PROMPT).toContain("Research Protocol");
    expect(DEFAULT_RESEARCH_PROMPT).toContain("recordEvidenceTool");
    expect(DEFAULT_RESEARCH_PROMPT).toContain("counter-evidence");
    expect(DEFAULT_RESEARCH_PROMPT).toContain("Sources");
  });

  it("uses the fallback when templates are unavailable", () => {
    expect(loadResearchPrompt([new URL("file:///missing/research.md")])).toContain(
      "evidence-led research agent",
    );
  });
});
