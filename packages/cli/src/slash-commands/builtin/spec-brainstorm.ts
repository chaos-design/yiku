import type { PromptSlashCommand, SlashCommandSubmitResult } from "../types.js";

export const specBrainstormCommand: PromptSlashCommand = {
  description: "Explore requirements and produce an approved design",
  execution: "idle",
  getSubmission: (_context, arguments_) => {
    const request = arguments_.raw.trim();
    return submission(
      arguments_.raw,
      [
        "Brainstorm a focused design for the following request:",
        request || "Use the current conversation to identify the feature to design.",
        "",
        "First inspect the repository context, existing patterns, constraints, and relevant tests.",
        "Use TodoWrite to track the workflow.",
        "Ask one clarifying question at a time when information is missing.",
        "Propose two or three viable approaches with trade-offs and a recommendation.",
        "Present architecture, data flow, error handling, and testing, then obtain explicit approval.",
        "Do not edit code or begin implementation during this workflow.",
        "Do not create Git commits.",
        "Write all questions and the final design in the current conversation language.",
      ].join("\n"),
    );
  },
  kind: "prompt",
  name: "spec:brainstorm",
  progressLabel: "Brainstorming specification",
  source: "builtin",
};

function submission(rawArguments: string, prompt: string): SlashCommandSubmitResult {
  const commandArgs = rawArguments.trim();
  return {
    activatedSkills: [],
    ...(commandArgs ? { commandArgs } : {}),
    commandName: "spec:brainstorm",
    displayPrompt: `/spec:brainstorm${commandArgs ? ` ${commandArgs}` : ""}`,
    kind: "submit",
    prompt,
  };
}
