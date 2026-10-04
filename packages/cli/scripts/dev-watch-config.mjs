import { relative, resolve } from "node:path";

export const CLI_WATCH_PACKAGE_PATHS = Object.freeze([
  "packages/cli",
  "packages/config",
  "packages/trajectory",
  "packages/hooks",
  "packages/atomic-flow",
  "packages/memories",
  "packages/evals",
  "packages/flow-graph",
  "packages/agents/code",
  "packages/agents/research",
  "packages/agent-orchestrator",
  "packages/agent-studio",
  "packages/agent-observatory",
]);

const SOURCE_FILE_PATTERN = /\.(?:css|html|json|md|ts|tsx)$/u;
const TEST_FILE_PATTERN = /\.(?:test|spec)\.tsx?$/u;
const TSCONFIG_PATTERN = /(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/u;

export function isRelevantWatchChange(fileName) {
  if (!fileName) {
    return true;
  }

  const normalizedFileName = normalizeWatchFileName(fileName);

  if (
    normalizedFileName === "package.json" ||
    normalizedFileName === "index.html" ||
    normalizedFileName === "vite.config.ts" ||
    TSCONFIG_PATTERN.test(normalizedFileName)
  ) {
    return true;
  }

  if (!normalizedFileName.startsWith("src/") && !normalizedFileName.startsWith("server/")) {
    return false;
  }

  return (
    !TEST_FILE_PATTERN.test(normalizedFileName) && SOURCE_FILE_PATTERN.test(normalizedFileName)
  );
}

export function createWatchChangeReason(repoRoot, rootPath, fileName) {
  if (!fileName) {
    return relative(repoRoot, rootPath);
  }

  return relative(repoRoot, resolve(rootPath, normalizeWatchFileName(fileName)));
}

function normalizeWatchFileName(fileName) {
  return fileName
    .toString()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/u, "");
}
