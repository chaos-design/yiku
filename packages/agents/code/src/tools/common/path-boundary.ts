import { promises as fs, type Stats } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { requireNonEmpty } from "./validation.js";
import { WorkspaceContext } from "./workspace-context.js";

export interface PathBoundaryOptions {
  readonly rootDir?: string | undefined;
  readonly workspace?: WorkspaceContext | undefined;
}

export type PathBoundaryErrorCode =
  | "PATH_CHANGED"
  | "PATH_ESCAPE"
  | "SYMLINK_ESCAPE"
  | "SYMLINK_WRITE_DENIED";

export class PathBoundaryError extends Error {
  public override readonly name = "PathBoundaryError";

  public constructor(
    public readonly code: PathBoundaryErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface PathIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly size: number;
}

export interface WritablePath {
  readonly identity: PathIdentity;
  readonly path: string;
}

export class PathBoundary {
  public readonly rootDir: string;
  private readonly workspace: WorkspaceContext;

  public constructor(options: PathBoundaryOptions = {}) {
    this.workspace =
      options.workspace ??
      new WorkspaceContext({
        rootDir: options.rootDir ?? process.cwd(),
      });
    this.rootDir = this.workspace.rootDir;
  }

  public resolve(inputPath: string): string {
    const nonEmptyPath = requireNonEmpty(inputPath, "path is required.");
    const resolvedPath = this.workspace.resolvePath(nonEmptyPath);
    this.assertInside(resolvedPath, "PATH_ESCAPE");

    return resolvedPath;
  }

  public async resolveExistingPath(inputPath: string): Promise<string> {
    const resolvedPath = this.resolve(inputPath);
    await fs.lstat(resolvedPath);
    const canonicalPath = await fs.realpath(resolvedPath);
    this.assertInside(canonicalPath, "SYMLINK_ESCAPE");
    return canonicalPath;
  }

  public async resolveWritablePath(inputPath: string): Promise<WritablePath> {
    const resolvedPath = this.resolve(inputPath);
    await this.assertNoSymlinkSegments(resolvedPath);
    const stat = await fs.lstat(resolvedPath);
    if (stat.isSymbolicLink()) {
      throw new PathBoundaryError(
        "SYMLINK_WRITE_DENIED",
        "Writing through symbolic links is not allowed.",
      );
    }
    const canonicalPath = await fs.realpath(resolvedPath);
    this.assertInside(canonicalPath, "SYMLINK_ESCAPE");
    return {
      identity: toIdentity(stat),
      path: canonicalPath,
    };
  }

  public async resolveCreatablePath(inputPath: string): Promise<string> {
    const resolvedPath = this.resolve(inputPath);
    await this.assertNoSymlinkSegments(resolvedPath);

    let existingPath = resolvedPath;
    while (true) {
      try {
        const stat = await fs.lstat(existingPath);
        if (stat.isSymbolicLink()) {
          throw new PathBoundaryError(
            "SYMLINK_WRITE_DENIED",
            "Creating files through symbolic links is not allowed.",
          );
        }
        if (existingPath !== resolvedPath && !stat.isDirectory()) {
          throw new Error("The nearest existing parent must be a directory.");
        }
        break;
      } catch (error) {
        if (!isMissingPathError(error)) {
          throw error;
        }
        const parentPath = dirname(existingPath);
        if (parentPath === existingPath) {
          throw error;
        }
        existingPath = parentPath;
      }
    }

    const canonicalParent = await fs.realpath(existingPath);
    this.assertInside(canonicalParent, "SYMLINK_ESCAPE");
    return resolvedPath;
  }

  public async assertUnchanged(path: string, identity: PathIdentity): Promise<void> {
    let stat: Stats;
    try {
      stat = await fs.lstat(path);
    } catch {
      throw new PathBoundaryError("PATH_CHANGED", "Path changed before the write completed.");
    }
    if (
      stat.isSymbolicLink() ||
      stat.dev !== identity.dev ||
      stat.ino !== identity.ino ||
      stat.mtimeMs !== identity.mtimeMs ||
      stat.size !== identity.size
    ) {
      throw new PathBoundaryError("PATH_CHANGED", "Path changed before the write completed.");
    }
  }

  public relative(filePath: string): string {
    const relativePath = relative(this.rootDir, filePath);
    return this.workspace.rootForPath(filePath) === this.rootDir ? relativePath || "." : filePath;
  }

  private assertInside(path: string, code: "PATH_ESCAPE" | "SYMLINK_ESCAPE"): void {
    if (!this.workspace.containsPath(path)) {
      throw new PathBoundaryError(
        code,
        code === "SYMLINK_ESCAPE"
          ? "Symbolic link resolves outside the configured root directory or authorized filesystem roots."
          : "Path must stay within the configured root directory.",
      );
    }
  }

  private async assertNoSymlinkSegments(path: string): Promise<void> {
    const pathRoot = this.workspace.rootForPath(path);
    if (pathRoot === undefined) {
      throw new PathBoundaryError(
        "PATH_ESCAPE",
        "Path must stay within the configured root directory.",
      );
    }
    const relativePath = relative(pathRoot, path);
    let currentPath = pathRoot;
    for (const segment of relativePath.split(sep).filter(Boolean)) {
      currentPath = resolve(currentPath, segment);
      try {
        if ((await fs.lstat(currentPath)).isSymbolicLink()) {
          throw new PathBoundaryError(
            "SYMLINK_WRITE_DENIED",
            "Writing through symbolic links is not allowed.",
          );
        }
      } catch (error) {
        if (isMissingPathError(error)) {
          return;
        }
        throw error;
      }
    }
  }
}

function toIdentity(stat: Stats): PathIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  };
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ENOTDIR")
  );
}
