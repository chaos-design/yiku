import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { YikuPaths } from "./paths.js";

export interface WorkspaceStorageLocatorOptions {
  readonly digest?: ((value: string) => string) | undefined;
  readonly homeDir?: string | undefined;
  readonly workspaceDir: string;
}

export interface WorkspaceStorageResolution {
  readonly metadataPath: string;
  readonly paths: YikuPaths;
  readonly rootRealPath: string;
  readonly storageDir: string;
  readonly storageName: string;
}

interface WorkspaceMetadata {
  readonly rootRealPath: string;
}

type StorageOwnership = "matching" | "unusable";

export class WorkspaceStorageLocator {
  public constructor(private readonly options: WorkspaceStorageLocatorOptions) {}

  public async resolve(): Promise<WorkspaceStorageResolution> {
    const inputPaths = new YikuPaths({
      homeDir: this.options.homeDir,
      workspaceDir: this.options.workspaceDir,
    });
    const rootRealPath = await realpath(inputPaths.workspaceDir);
    const canonicalPaths = new YikuPaths({
      homeDir: inputPaths.homeDir,
      workspaceDir: rootRealPath,
    });
    const baseName = canonicalPaths.workspaceStorageName;

    if (await this.claimStorage(baseName, inputPaths, rootRealPath)) {
      return this.resolution(baseName, inputPaths, rootRealPath);
    }

    const hash = this.workspaceHash(rootRealPath);
    const hashName = `${baseName}_${hash}`;
    if (!(await this.claimStorage(hashName, inputPaths, rootRealPath))) {
      throw new Error(`Workspace storage hash collision: ${hashName}.`);
    }
    return this.resolution(hashName, inputPaths, rootRealPath);
  }

  private async claimStorage(
    storageName: string,
    inputPaths: YikuPaths,
    rootRealPath: string,
  ): Promise<boolean> {
    const paths = new YikuPaths({
      homeDir: inputPaths.homeDir,
      workspaceDir: inputPaths.workspaceDir,
      workspaceStorageName: storageName,
    });
    const storageRoot = dirname(paths.workspaceStorageDir);
    const temporaryStorageDir = join(storageRoot, `.${storageName}.${randomUUID()}.tmp`);
    let temporaryStorageCreated = false;

    if (await pathExists(paths.workspaceStorageDir)) {
      return (
        (await readStorageOwnership(paths.workspaceMetadataFilePath, rootRealPath)) === "matching"
      );
    }

    try {
      await mkdir(storageRoot, { mode: 0o700, recursive: true });
      await mkdir(temporaryStorageDir, { mode: 0o700 });
      temporaryStorageCreated = true;
      await writeMetadata(join(temporaryStorageDir, "workspace.json"), { rootRealPath });
      await rename(temporaryStorageDir, paths.workspaceStorageDir);
      temporaryStorageCreated = false;
      return true;
    } catch (error) {
      if (!isStorageClaimConflict(error)) {
        throw error;
      }
      return (
        (await readStorageOwnership(paths.workspaceMetadataFilePath, rootRealPath)) === "matching"
      );
    } finally {
      if (temporaryStorageCreated) {
        await rm(temporaryStorageDir, { force: true, recursive: true }).catch(() => undefined);
      }
    }
  }

  private resolution(
    storageName: string,
    inputPaths: YikuPaths,
    rootRealPath: string,
  ): WorkspaceStorageResolution {
    const paths = new YikuPaths({
      homeDir: inputPaths.homeDir,
      workspaceDir: inputPaths.workspaceDir,
      workspaceStorageName: storageName,
    });
    return {
      metadataPath: paths.workspaceMetadataFilePath,
      paths,
      rootRealPath,
      storageDir: paths.workspaceStorageDir,
      storageName,
    };
  }

  private workspaceHash(rootRealPath: string): string {
    const digest =
      this.options.digest?.(rootRealPath) ??
      createHash("sha256").update(rootRealPath).digest("hex");
    const hash = digest.slice(0, 8).toLowerCase();
    if (!/^[a-f0-9]{8}$/u.test(hash)) {
      throw new Error("Workspace storage digest must begin with eight hexadecimal characters.");
    }
    return hash;
  }
}

async function readStorageOwnership(
  metadataPath: string,
  rootRealPath: string,
): Promise<StorageOwnership> {
  try {
    const value: unknown = JSON.parse(await readFile(metadataPath, "utf8"));
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      "rootRealPath" in value &&
      value.rootRealPath === rootRealPath
    ) {
      return "matching";
    }
  } catch {
    return "unusable";
  }
  return "unusable";
}

async function writeMetadata(metadataPath: string, metadata: WorkspaceMetadata): Promise<void> {
  const temporaryPath = `${metadataPath}.${randomUUID()}.tmp`;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(temporaryPath, "wx", 0o600);
    await file.writeFile(`${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporaryPath, metadataPath);
  } catch (error) {
    await file?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isStorageClaimConflict(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "EEXIST" || error.code === "ENOTEMPTY")
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
