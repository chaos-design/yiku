import type { PromptSlashCommand, SlashCommandSubmitResult } from "../types.js";

export const specExecutePlanCommand: PromptSlashCommand = {
  description: "Execute an implementation plan with verification checkpoints",
  execution: "idle",
  getSubmission: (_context, arguments_) => {
    const plan = arguments_.raw.trim();
    return submission(
      arguments_.raw,
      [
        "Execute the following implementation plan:",
        plan || "Use the implementation plan approved in the current conversation.",
        "",
        "Read the complete plan and inspect the current worktree before changing files.",
        "Use TodoWrite to track every task and keep exactly one task in progress.",
        "Implement in small batches and run the plan's focused verification after each batch.",
        "At each checkpoint, report completed work, test results, and the next batch.",
        "Preserve unrelated worktree changes and stop to explain genuine blockers.",
        "Complete final focused tests, lint, and build checks required by the repository.",
        "Do not create Git commits.",
        "Write progress and the final report in the current conversation language.",
      ].join("\n"),
    );
  },
  kind: "prompt",
  name: "spec:execute-plan",
  progressLabel: "Executing implementation plan",
  source: "builtin",
};

function submission(rawArguments: string, prompt: string): SlashCommandSubmitResult {
  const commandArgs = rawArguments.trim();
  return {
    activatedSkills: [],
    ...(commandArgs ? { commandArgs } : {}),
    commandName: "spec:execute-plan",
    displayPrompt: `/spec:execute-plan${commandArgs ? ` ${commandArgs}` : ""}`,
    kind: "submit",
    prompt,
  };
}
