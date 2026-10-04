import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  WorkspaceAccessController,
  type WorkspaceAccessMode,
} from "../../permission/workspace-access.js";
import { EnvironmentPolicy } from "./environment-policy.js";
import { requireNonEmpty } from "./validation.js";

export interface WorkspaceContextOptions {
  readonly accessController?: WorkspaceAccessController | undefined;
  readonly accessMode?: WorkspaceAccessMode | undefined;
  readonly additionalRootDirs?: readonly string[] | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly environmentPolicy?: EnvironmentPolicy | undefined;
  readonly homeDir?: string | undefined;
  readonly rootDir: string;
}

export class WorkspaceContext {
  public readonly accessController: WorkspaceAccessController;
  public readonly environment: Readonly<NodeJS.ProcessEnv>;
  public readonly homeDir?: string | undefined;
  public readonly rootDir: string;
  public readonly rootDirs: readonly string[];
  public readonly workspaceId: string;

  public constructor(options: WorkspaceContextOptions) {
    const requestedRoot = resolve(
      requireNonEmpty(options.rootDir, "Workspace directory is required."),
    );
    this.rootDir = canonicalPath(requestedRoot);
    this.accessController =
      options.accessController ??
      new WorkspaceAccessController({
        accessMode: options.accessMode ?? "read-write",
      });
    if (
      options.accessController !== undefined &&
      options.accessMode !== undefined &&
      options.accessController.accessMode !== options.accessMode
    ) {
      throw new Error("Workspace access mode must match the Access Controller.");
    }
    this.homeDir =
      options.homeDir === undefined
        ? undefined
        : canonicalPath(resolve(options.homeDir), "Home directory");
    this.rootDirs = Object.freeze(
      uniquePaths([
        this.rootDir,
        ...(options.additionalRootDirs ?? []).map((path) =>
          canonicalPath(resolve(path), "Additional filesystem root"),
        ),
      ]),
    );
    const environmentPolicy = options.environmentPolicy ?? new EnvironmentPolicy();
    const environment = environmentPolicy.buildProcessEnv(options.environment ?? process.env);
    if (this.homeDir !== undefined) {
      environment.HOME = this.homeDir;
    }
    this.environment = Object.freeze(environment);
    this.workspaceId = createHash("sha256").update(this.rootDir).digest("hex").slice(0, 16);
    Object.freeze(this);
  }

  public get accessMode(): WorkspaceAccessMode {
    return this.accessController.accessMode;
  }

  public containsPath(path: string): boolean {
    const resolvedPath = resolve(path);
    return this.rootDirs.some((rootDir) => isInside(rootDir, resolvedPath));
  }

  public rootForPath(path: string): string | undefined {
    const resolvedPath = resolve(path);
    return this.rootDirs
      .filter((rootDir) => isInside(rootDir, resolvedPath))
      .toSorted((left, right) => right.length - left.length)[0];
  }

  public resolvePath(path: string, fromDir = this.rootDir): string {
    if (path === "~" || path.startsWith("~/") || path.startsWith("~\\")) {
      if (this.homeDir === undefined) {
        throw new Error("Home-relative paths are not configured for this workspace.");
      }
      return path === "~" ? this.homeDir : resolve(this.homeDir, path.slice(2));
    }
    if (path.startsWith("~")) {
      throw new Error("Only the current user's home-relative path syntax is supported.");
    }
    return isAbsolute(path) ? resolve(path) : resolve(fromDir, path);
  }

  public assertPath(path: string): string {
    const canonical = canonicalPath(path, "Workspace path");
    if (!this.containsPath(canonical)) {
      throw new Error("Path must stay within the configured filesystem roots.");
    }
    return canonical;
  }
}

function canonicalPath(path: string, label = "Workspace path"): string {
  try {
    return realpathSync.native(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} must exist and be accessible: ${message}`);
  }
}

function isInside(rootDir: string, path: string): boolean {
  const relativePath = relative(rootDir, path);
  return relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

function uniquePaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)];
}
