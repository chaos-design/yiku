import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { commandDetails } from "./shell-parser.js";
import {
  createShellAssessment,
  type ParsedShellCommand,
  type ShellCommandAssessment,
  type ShellPolicyContext,
} from "./terminal-types.js";

const OUTPUT_ONLY_COMMANDS = new Set(["echo", "printf"]);
const NULL_DEVICE_PATH = "/dev/null";

export function assessPathBoundary(
  parsed: ParsedShellCommand,
  context: ShellPolicyContext,
): ShellCommandAssessment | undefined {
  for (const target of parsed.redirectionTargets) {
    const targetAssessment = assessPathCandidates([target], context, true);
    if (targetAssessment !== undefined) {
      return targetAssessment;
    }
  }
  for (const segment of parsed.segments) {
    const details = commandDetails(segment);
    if (details === undefined || OUTPUT_ONLY_COMMANDS.has(details.executable)) {
      continue;
    }
    const candidateAssessment = assessPathCandidates(details.words, context);
    if (candidateAssessment !== undefined) {
      return candidateAssessment;
    }
  }
  return undefined;
}

export function isSafeDiscardPath(path: string): boolean {
  return resolve(path) === NULL_DEVICE_PATH;
}

function assessPathCandidates(
  words: readonly string[],
  context: ShellPolicyContext,
  allowSafeExternalPaths = false,
): ShellCommandAssessment | undefined {
  for (const word of words) {
    const candidate = pathCandidate(word);
    if (candidate === undefined) {
      continue;
    }
    if (allowSafeExternalPaths && isSafeDiscardPath(candidate)) {
      continue;
    }
    if (candidate.includes("$")) {
      return createShellAssessment(
        "dynamic-shell-path",
        "execute command with dynamic path",
        "deny",
        "high",
        ["process.execute", "filesystem.dynamic-path"],
        "uses a path that cannot be resolved before process start",
      );
    }
    if (isOutsideWorkspace(candidate, context)) {
      return createShellAssessment(
        "workspace-path-escape",
        "access path outside workspace",
        "deny",
        "high",
        ["process.execute", "filesystem.outside-workspace"],
        "references a path outside the authorized workspace",
      );
    }
  }
  return undefined;
}

function pathCandidate(word: string): string | undefined {
  if (!word || /^[a-z][a-z\d+.-]*:\/\//iu.test(word) || word === "-" || /^[\d.]+$/u.test(word)) {
    return undefined;
  }
  const optionValue = word.startsWith("-") ? word.split("=", 2)[1] : undefined;
  const candidate = optionValue ?? word;
  if (
    candidate === "." ||
    candidate === ".." ||
    candidate.startsWith("./") ||
    candidate.startsWith("../") ||
    candidate.startsWith("/") ||
    candidate.startsWith("~") ||
    candidate.includes("/") ||
    candidate.includes("$")
  ) {
    return candidate;
  }
  return undefined;
}

function isOutsideWorkspace(candidate: string, context: ShellPolicyContext): boolean {
  let resolvedPath: string;
  try {
    resolvedPath = context.workspace.resolvePath(candidate, context.currentCwd);
  } catch {
    return true;
  }
  if (!context.workspace.containsPath(resolvedPath)) {
    return true;
  }
  let existingPath = resolvedPath;
  while (!existsSync(existingPath)) {
    const parentPath = dirname(existingPath);
    if (parentPath === existingPath) {
      return true;
    }
    existingPath = parentPath;
  }
  try {
    context.workspace.assertPath(existingPath);
    return false;
  } catch {
    return true;
  }
}
