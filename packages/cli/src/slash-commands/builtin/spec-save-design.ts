import type { PromptSlashCommand, SlashCommandSubmitResult } from "../types.js";

export const specSaveDesignCommand: PromptSlashCommand = {
  description: "Save an approved design as a dated document",
  execution: "idle",
  getSubmission: (_context, arguments_) => {
    const slug = arguments_.raw.trim();
    return submission(
      arguments_.raw,
      [
        "Save the approved design from the current conversation.",
        slug
          ? `Use the requested slug or topic: ${slug}.`
          : "Derive a concise lowercase kebab-case slug from the approved design.",
        "Write it to docs/designs/YYYY-MM-DD-<slug>.md using the current local date.",
        "Preserve approved decisions, constraints, architecture, data flow, error handling, and tests.",
        "Resolve any remaining ambiguity from the approved conversation; do not invent new scope.",
        "Use TodoWrite to track document creation and verification.",
        "Do not modify implementation files. Do not create Git commits.",
        "Write the document and final response in the current conversation language.",
      ].join("\n"),
    );
  },
  kind: "prompt",
  name: "spec:save-design",
  progressLabel: "Saving approved design",
  source: "builtin",
};

function submission(rawArguments: string, prompt: string): SlashCommandSubmitResult {
  const commandArgs = rawArguments.trim();
  return {
    activatedSkills: [],
    ...(commandArgs ? { commandArgs } : {}),
    commandName: "spec:save-design",
    displayPrompt: `/spec:save-design${commandArgs ? ` ${commandArgs}` : ""}`,
    kind: "submit",
    prompt,
  };
}
