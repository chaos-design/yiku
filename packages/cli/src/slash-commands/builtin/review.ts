import type { PromptSlashCommand, SlashCommandSubmitResult } from "../types.js";

const STAGED_DIFF_COMMAND = [
  "git diff --cached -- .",
  "':(exclude)**/package-lock.json'",
  "':(exclude)**/npm-shrinkwrap.json'",
  "':(exclude)**/pnpm-lock.yaml'",
  "':(exclude)**/yarn.lock'",
  "':(exclude)**/bun.lock'",
  "':(exclude)**/bun.lockb'",
].join(" ");

export const reviewCommand: PromptSlashCommand = {
  description: "Review staged changes or a pull request",
  execution: "idle",
  getSubmission: (_context, arguments_) => {
    const pullRequest = arguments_.raw.trim();
    const diffInstruction = pullRequest
      ? `Inspect the pull request with \`gh pr diff ${pullRequest}\`.`
      : [
          "Review only staged changes.",
          `Inspect them with \`${STAGED_DIFF_COMMAND}\` so generated lockfile noise is excluded.`,
        ].join(" ");

    return submission(
      arguments_.raw,
      [
        "Perform a rigorous code review of the requested changes.",
        diffInstruction,
        "Read the repository instructions and relevant surrounding code before judging the diff.",
        "Prioritize correctness bugs, regressions, security issues, concurrency hazards, and missing tests.",
        "Report findings first, ordered by severity, with concrete file and line references.",
        "Do not modify files. Do not create Git commits.",
        "Use TodoWrite to track the review when it has multiple steps.",
        "Write the final response in the current conversation language.",
      ].join("\n"),
    );
  },
  kind: "prompt",
  name: "review",
  progressLabel: "Preparing code review",
  source: "builtin",
};

function submission(rawArguments: string, prompt: string): SlashCommandSubmitResult {
  const commandArgs = rawArguments.trim();
  return {
    activatedSkills: [],
    ...(commandArgs ? { commandArgs } : {}),
    commandName: "review",
    displayPrompt: `/review${commandArgs ? ` ${commandArgs}` : ""}`,
    kind: "submit",
    prompt,
  };
}
