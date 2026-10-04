import { basename } from "node:path";
import { commandDetails, hasCommandFlag } from "./shell-parser.js";
import { isSafeDiscardPath } from "./shell-path-policy.js";
import {
  createShellAssessment,
  type ParsedShellCommand,
  type ShellCommandAssessment,
  type ShellCommandDetails,
} from "./terminal-types.js";

const PACKAGE_MANAGERS = new Set(["bun", "npm", "pnpm", "yarn"]);
const SAFE_PACKAGE_SCRIPTS = new Set(["build", "check", "format", "lint", "test", "typecheck"]);

export function assessHostBoundary(
  segments: readonly (readonly string[])[],
): ShellCommandAssessment | undefined {
  for (const segment of segments) {
    const details = commandDetails(segment);
    if (details === undefined) {
      continue;
    }
    const { executable, words } = details;

    if (["doas", "su", "sudo"].includes(executable)) {
      return createShellAssessment(
        "host-privilege",
        "use elevated host privileges",
        "deny",
        "high",
        ["process.execute", "host.admin"],
        "uses elevated host privileges",
      );
    }
    if (
      executable.startsWith("mkfs") ||
      (executable === "diskutil" && words[0]?.startsWith("erase"))
    ) {
      return createShellAssessment(
        "disk-format",
        "format or erase host storage",
        "deny",
        "high",
        ["process.execute", "host.storage.write"],
        "formats or erases storage devices",
      );
    }
    if (executable === "dd" && words.some((word) => word.startsWith("of="))) {
      return createShellAssessment(
        "raw-device-write",
        "write raw host storage",
        "deny",
        "high",
        ["process.execute", "host.storage.write"],
        "writes raw data to a device or file",
      );
    }
    if (
      executable === "pkill" ||
      executable === "killall" ||
      (executable === "kill" && words.includes("-9"))
    ) {
      return createShellAssessment(
        "force-kill-process",
        "control host processes",
        "deny",
        "high",
        ["process.execute", "host.process.signal"],
        "forcefully controls host processes",
      );
    }
  }
  return undefined;
}

export function assessCommandActions(
  segments: readonly (readonly string[])[],
): ShellCommandAssessment | undefined {
  for (const segment of segments) {
    const details = commandDetails(segment);
    if (details === undefined) {
      continue;
    }
    const { executable, words } = details;
    const rmWords = rmArguments(details);

    if (rmWords !== undefined) {
      const recursive = hasCommandFlag(rmWords, "r", "recursive");
      const force = hasCommandFlag(rmWords, "f", "force");
      return createShellAssessment(
        recursive ? (force ? "recursive-force-rm" : "recursive-rm") : "remove-path",
        recursive
          ? force
            ? "recursively force-remove workspace paths"
            : "recursively remove workspace paths"
          : "remove workspace paths",
        "ask",
        "high",
        ["process.execute", "workspace.delete"],
        recursive
          ? force
            ? "recursively force-removes files or directories"
            : "recursively removes files or directories"
          : "removes files or directories",
      );
    }
    if (executable === "mv") {
      return createShellAssessment(
        "move-path",
        "move or replace workspace paths",
        "ask",
        "high",
        ["process.execute", "workspace.move"],
        "moves source paths and can overwrite destination paths",
      );
    }
    if (executable === "git") {
      const subcommand = gitSubcommand(words);
      if (subcommand === "reset" && words.includes("--hard")) {
        return createShellAssessment(
          "git-reset-hard",
          "discard local Git changes",
          "ask",
          "high",
          ["process.execute", "workspace.write", "git.history"],
          "discards local git changes",
        );
      }
      if (
        subcommand === "clean" &&
        hasCommandFlag(words, "f", "force") &&
        hasCommandFlag(words, "d", "directories")
      ) {
        return createShellAssessment(
          "git-clean-force-directory",
          "remove untracked Git files and directories",
          "ask",
          "high",
          ["process.execute", "workspace.delete", "git.history"],
          "removes untracked git files and directories",
        );
      }
      if ((subcommand === "checkout" || subcommand === "restore") && words.includes("--")) {
        return createShellAssessment(
          "git-discard-worktree",
          "discard local file changes",
          "ask",
          "high",
          ["process.execute", "workspace.write", "git.history"],
          "discards local file changes",
        );
      }
    }
    if (executable === "find" && words.includes("-delete")) {
      return createShellAssessment(
        "find-delete",
        "delete files matched by find",
        "ask",
        "high",
        ["process.execute", "workspace.delete"],
        "deletes files found by a search expression",
      );
    }
    if (
      (executable === "chmod" || executable === "chown") &&
      hasCommandFlag(words, "R", "recursive")
    ) {
      return createShellAssessment(
        "recursive-permission-change",
        "recursively change permissions or ownership",
        "ask",
        "high",
        ["process.execute", "workspace.permissions"],
        "recursively changes permissions or ownership",
      );
    }
    if (isPackageCommand(details, "publish")) {
      return createShellAssessment(
        "package-publish",
        "publish a package",
        "ask",
        "high",
        ["process.execute", "network.connect", "package.publish"],
        "publishes a package",
      );
    }
    if (["bash", "fish", "sh", "zsh"].includes(executable) && words.includes("-c")) {
      return createShellAssessment(
        "shell-wrapper",
        "run a nested shell command",
        "ask",
        "high",
        ["process.execute", "shell.opaque"],
        "runs a nested shell command that cannot be safely classified",
      );
    }
  }
  return undefined;
}

export function isRemoteShellPipeline(parsed: ParsedShellCommand): boolean {
  if (!parsed.complex) {
    return false;
  }
  const executables = parsed.segments
    .map((segment) => commandDetails(segment)?.executable)
    .filter((executable): executable is string => executable !== undefined);
  return (
    executables.some((executable) => ["curl", "wget"].includes(executable)) &&
    executables.some((executable) => ["bash", "fish", "sh", "zsh"].includes(executable))
  );
}

export function isNetworkCommand(segment: readonly string[]): boolean {
  const details = commandDetails(segment);
  if (details === undefined) {
    return false;
  }
  if (["curl", "nc", "ncat", "scp", "sftp", "ssh", "telnet", "wget"].includes(details.executable)) {
    return true;
  }
  if (details.executable === "git") {
    return ["clone", "fetch", "pull", "push"].includes(gitSubcommand(details.words) ?? "");
  }
  return ["add", "install", "update"].some((subcommand) => isPackageCommand(details, subcommand));
}

export function isSafeWorkspaceWrite(parsed: ParsedShellCommand): boolean {
  if (parsed.dynamic) {
    return false;
  }

  let hasWrite =
    parsed.outputRedirectionTargets.length > 0 && !hasOnlyDiscardOutputRedirections(parsed);
  for (const segment of parsed.segments) {
    const details = commandDetails(segment);
    if (details === undefined) {
      return false;
    }
    if (isWorkspaceWriteCommand(details)) {
      hasWrite = true;
      continue;
    }
    if (!isSafeCommand(segment)) {
      return false;
    }
  }

  return hasWrite;
}

export function isSafeDiscardOnlyCommand(parsed: ParsedShellCommand): boolean {
  return (
    parsed.complex &&
    !parsed.dynamic &&
    !parsed.hasComplexOperator &&
    hasOnlyDiscardOutputRedirections(parsed) &&
    parsed.segments.every((segment) => isSafeCommand(segment))
  );
}

export function isSafeCommand(segment: readonly string[]): boolean {
  const details = commandDetails(segment);
  if (details === undefined) {
    return false;
  }
  const { executable, words } = details;

  if (["cd", "echo", "false", "printf", "pwd", "sleep", "true"].includes(executable)) {
    return true;
  }
  if (["cat", "grep", "head", "less", "ls", "more", "rg", "tail", "wc"].includes(executable)) {
    return true;
  }
  if (executable === "git") {
    return isSafeGitCommand(words);
  }
  if (executable === "corepack") {
    const [packageManager, ...packageWords] = words;
    return (
      packageManager !== undefined &&
      PACKAGE_MANAGERS.has(packageManager) &&
      isSafePackageCommand(packageWords)
    );
  }
  if (PACKAGE_MANAGERS.has(executable)) {
    return isSafePackageCommand(words);
  }
  if (executable === "tsc" || executable === "vitest") {
    return true;
  }
  return executable === "biome" && words[0] === "check";
}

export function extractNetworkHosts(command: string): readonly string[] {
  const hosts: string[] = [];
  for (const match of command.matchAll(/\bhttps?:\/\/([^\s/'"]+)/giu)) {
    if (match[1]) {
      hosts.push(match[1]);
    }
  }
  return hosts;
}

function rmArguments(details: ShellCommandDetails): readonly string[] | undefined {
  if (details.executable === "rm") {
    return details.words;
  }
  if (details.executable === "xargs") {
    return wordsAfterExecutable(details.words, "rm");
  }
  if (details.executable === "find") {
    const execIndex = details.words.findIndex((word) => word === "-exec" || word === "-execdir");
    if (execIndex >= 0) {
      return wordsAfterExecutable(details.words.slice(execIndex + 1), "rm");
    }
  }
  return undefined;
}

function wordsAfterExecutable(
  words: readonly string[],
  executable: string,
): readonly string[] | undefined {
  const index = words.findIndex((word) => basename(word).toLowerCase() === executable);
  return index >= 0 ? words.slice(index + 1) : undefined;
}

function hasOnlyDiscardOutputRedirections(parsed: ParsedShellCommand): boolean {
  return (
    parsed.outputRedirectionTargets.length > 0 &&
    parsed.outputRedirectionTargets.every(isSafeDiscardPath)
  );
}

function isWorkspaceWriteCommand(details: ShellCommandDetails): boolean {
  if (["mkdir", "tee", "touch"].includes(details.executable)) {
    return true;
  }
  if (details.executable === "cp") {
    return !details.words.includes("--remove-destination");
  }
  return (
    details.executable === "sed" &&
    details.words.some((word) => word === "--in-place" || word.startsWith("-i"))
  );
}

function isPackageCommand(details: ShellCommandDetails, expectedSubcommand: string): boolean {
  if (details.executable === "corepack") {
    const [packageManager, ...words] = details.words;
    return (
      packageManager !== undefined &&
      PACKAGE_MANAGERS.has(packageManager) &&
      packageSubcommand(words) === expectedSubcommand
    );
  }
  return (
    PACKAGE_MANAGERS.has(details.executable) &&
    packageSubcommand(details.words) === expectedSubcommand
  );
}

function isSafeGitCommand(words: readonly string[]): boolean {
  return ["diff", "log", "rev-parse", "show", "status"].includes(gitSubcommand(words) ?? "");
}

function gitSubcommand(words: readonly string[]): string | undefined {
  const withGlobalOptionsRemoved = [...words];
  while (withGlobalOptionsRemoved[0]?.startsWith("-")) {
    const option = withGlobalOptionsRemoved.shift();
    if (option === "-C" || option === "--git-dir" || option === "--work-tree") {
      withGlobalOptionsRemoved.shift();
    }
  }
  return withGlobalOptionsRemoved[0];
}

function isSafePackageCommand(words: readonly string[]): boolean {
  return SAFE_PACKAGE_SCRIPTS.has(packageSubcommand(words) ?? "");
}

function packageSubcommand(words: readonly string[]): string | undefined {
  const remaining = [...words];
  while (remaining[0]?.startsWith("-")) {
    const option = remaining.shift();
    if (option === "--filter" || option === "--dir" || option === "-C") {
      remaining.shift();
    }
  }
  if (remaining[0] === "run") {
    remaining.shift();
  }
  return remaining[0];
}
