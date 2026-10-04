import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export interface YikuPathsOptions {
  readonly homeDir?: string | undefined;
  readonly workspaceDir: string;
  readonly workspaceStorageName?: string | undefined;
}

export class YikuPaths {
  public readonly atomicRunsDir: string;
  public readonly configFilePath: string;
  public readonly envFilePath: string;
  public readonly evalsDir: string;
  public readonly globalMemoryFilePath: string;
  public readonly homeDir: string;
  public readonly permissionFilePath: string;
  public readonly runsDir: string;
  public readonly sessionsDir: string;
  public readonly workspaceDir: string;
  public readonly workspaceMemoryFilePath: string;
  public readonly workspaceMetadataFilePath: string;
  public readonly workspaceName: string;
  public readonly workspaceParentName: string;
  public readonly workspaceStorageDir: string;
  public readonly workspaceStorageName: string;
  public readonly yikuDir: string;

  public constructor(options: YikuPathsOptions) {
    if (!isAbsolute(options.workspaceDir)) {
      throw new Error("Yiku Workspace path must be absolute.");
    }

    this.homeDir = resolve(options.homeDir ?? homedir());
    this.workspaceDir = resolve(options.workspaceDir);
    this.workspaceName = basename(this.workspaceDir);
    if (!this.workspaceName || this.workspaceName === "." || this.workspaceName === "..") {
      throw new Error("Yiku Workspace path must have a directory name.");
    }
    this.workspaceParentName = basename(dirname(this.workspaceDir));
    if (!this.workspaceParentName) {
      throw new Error("Yiku Workspace path must have a parent directory name.");
    }
    this.workspaceStorageName =
      options.workspaceStorageName === undefined
        ? [
            normalizeStorageSegment(this.workspaceParentName),
            normalizeStorageSegment(this.workspaceName),
          ].join("_")
        : validateWorkspaceStorageName(options.workspaceStorageName);

    this.yikuDir = join(this.homeDir, ".yiku");
    this.configFilePath = join(this.yikuDir, "config.yaml");
    this.envFilePath = join(this.yikuDir, ".env");
    this.permissionFilePath = join(this.yikuDir, "permission", "global.json");
    this.globalMemoryFilePath = join(this.yikuDir, "memory", "memories.sqlite");
    this.workspaceStorageDir = join(this.yikuDir, "workspaces", this.workspaceStorageName);
    this.workspaceMetadataFilePath = join(this.workspaceStorageDir, "workspace.json");
    this.sessionsDir = join(this.workspaceStorageDir, "session");
    this.atomicRunsDir = join(this.workspaceStorageDir, "logs", "atomic-runs");
    this.runsDir = join(this.workspaceStorageDir, "logs", "runs");
    this.evalsDir = join(this.workspaceStorageDir, "evals");
    this.workspaceMemoryFilePath = join(this.workspaceStorageDir, "memory", "memories.sqlite");
  }
}

function normalizeStorageSegment(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "");
  if (!normalized) {
    throw new Error("Yiku Workspace storage name contains no usable characters.");
  }
  return normalized;
}

function validateWorkspaceStorageName(value: string): string {
  const characterLength = Array.from(value).length;
  if (
    characterLength < 1 ||
    characterLength > 255 ||
    value !== value.normalize("NFKC").toLowerCase() ||
    !/^[\p{L}\p{N}]+(?:_[\p{L}\p{N}]+)*$/u.test(value)
  ) {
    throw new Error("Yiku Workspace storage name must be a normalized single directory name.");
  }
  return value;
}
