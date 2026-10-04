import type { PromptSlashCommand, SlashCommandSubmitResult } from "../types.js";

export const specWritePlanCommand: PromptSlashCommand = {
  description: "Turn an approved design into an implementation plan",
  execution: "idle",
  getSubmission: (_context, arguments_) => {
    const design = arguments_.raw.trim();
    return submission(
      arguments_.raw,
      [
        "Write an executable implementation plan for this approved design or request:",
        design || "Use the approved design in the current conversation.",
        "",
        "Inspect the current repository before planning and follow its local conventions.",
        "Use TodoWrite to track planning.",
        "Break the work into small ordered tasks with exact file paths and concrete code changes.",
        "For every task, include focused tests, expected outcomes, and verification commands.",
        "Call out compatibility, error handling, migration, and rollback concerns where relevant.",
        "Keep index files export-only and use relative imports.",
        "Do not implement the plan. Do not create Git commits.",
        "Write the plan in the current conversation language.",
      ].join("\n"),
    );
  },
  kind: "prompt",
  name: "spec:write-plan",
  progressLabel: "Writing implementation plan",
  source: "builtin",
};

function submission(rawArguments: string, prompt: string): SlashCommandSubmitResult {
  const commandArgs = rawArguments.trim();
  return {
    activatedSkills: [],
    ...(commandArgs ? { commandArgs } : {}),
    commandName: "spec:write-plan",
    displayPrompt: `/spec:write-plan${commandArgs ? ` ${commandArgs}` : ""}`,
    kind: "submit",
    prompt,
  };
}
