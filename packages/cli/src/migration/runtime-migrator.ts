import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { YikuPaths } from "@yiku/config";

const MIGRATION_VERSION = 1;

export interface RuntimeMigrationOptions {
  readonly homeDir: string;
  readonly now?: Date | undefined;
  readonly workspaceDir: string;
}

export interface RuntimeMigrationResult {
  readonly migrated: boolean;
  readonly removedPaths: readonly string[];
  readonly storageDir: string;
}

export async function migrateLegacyRuntime(
  options: RuntimeMigrationOptions,
): Promise<RuntimeMigrationResult> {
  const paths = new YikuPaths(options);
  const legacyRoot = join(paths.workspaceDir, ".yiku");
  const sources = runtimeSources(legacyRoot, paths);
  const existingSources = sources.filter((source) => existsSync(source.path));
  const legacyTrustPath = join(legacyRoot, "trust", "workspace.json");
  const hasLegacyTrust = existsSync(legacyTrustPath);
  if (existingSources.length === 0 && !hasLegacyTrust) {
    return {
      migrated: false,
      removedPaths: [],
      storageDir: paths.workspaceStorageDir,
    };
  }

  await mkdir(paths.workspaceStorageDir, { mode: 0o700, recursive: true });
  const lockPath = join(paths.workspaceStorageDir, ".migration.lock");
  const lock = await open(lockPath, "wx", 0o600);
  try {
    await checkpointLegacyMemory(join(legacyRoot, "memories.sqlite"));
    const copiedSources = sources.filter((source) => existsSync(source.path));
    for (const source of copiedSources) {
      await copySource(source.path, source.target, options.now ?? new Date());
    }
    await writeWorkspaceMetadata(paths, options.now ?? new Date());

    const removedPaths = copiedSources.map((source) => source.path);
    await Promise.all(removedPaths.map((path) => rm(path, { force: true, recursive: true })));
    if (hasLegacyTrust) {
      await rm(join(legacyRoot, "trust"), { force: true, recursive: true });
      removedPaths.push(legacyTrustPath);
    }
    await removeIfEmpty(legacyRoot);
    return {
      migrated: true,
      removedPaths: Object.freeze(removedPaths),
      storageDir: paths.workspaceStorageDir,
    };
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

interface RuntimeSource {
  readonly path: string;
  readonly target: string;
}

function runtimeSources(legacyRoot: string, paths: YikuPaths): RuntimeSource[] {
  return [
    { path: join(legacyRoot, "sessions"), target: paths.sessionsDir },
    { path: join(legacyRoot, "atomic-runs"), target: paths.atomicRunsDir },
    { path: join(legacyRoot, "runs"), target: paths.runsDir },
    {
      path: join(legacyRoot, "memories.sqlite"),
      target: paths.workspaceMemoryFilePath,
    },
    {
      path: join(legacyRoot, "memories.sqlite-wal"),
      target: `${paths.workspaceMemoryFilePath}-wal`,
    },
    {
      path: join(legacyRoot, "memories.sqlite-shm"),
      target: `${paths.workspaceMemoryFilePath}-shm`,
    },
  ];
}

async function copySource(source: string, target: string, now: Date): Promise<void> {
  const sourceStat = await lstat(source);
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`Legacy runtime source must not be a symbolic link: ${source}`);
  }
  if (sourceStat.isDirectory()) {
    await copyDirectory(source, target, now);
    return;
  }
  if (!sourceStat.isFile()) {
    throw new Error(`Legacy runtime source must be a file or directory: ${source}`);
  }
  await copyFileWithConflict(source, target, now);
}

async function copyDirectory(source: string, target: string, now: Date): Promise<void> {
  await mkdir(target, { mode: 0o700, recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    await copySource(join(source, entry.name), join(target, entry.name), now);
  }
}

async function copyFileWithConflict(source: string, target: string, now: Date): Promise<void> {
  let destination = target;
  if (existsSync(destination)) {
    if ((await fileDigest(source)) === (await fileDigest(destination))) {
      return;
    }
    destination = await availableLegacyPath(destination, now);
  }
  await mkdir(dirname(destination), { mode: 0o700, recursive: true });
  const temporaryPath = join(dirname(destination), `.${randomUUID()}.yiku-migration.tmp`);
  await copyFile(source, temporaryPath);
  const handle = await open(temporaryPath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, destination);
    await chmod(destination, (await lstat(source)).mode & 0o777);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function availableLegacyPath(path: string, now: Date): Promise<string> {
  const suffix = now
    .toISOString()
    .replaceAll(/[^0-9]/gu, "")
    .slice(0, 14);
  const directory = dirname(path);
  const name = basename(path);
  for (let index = 0; ; index += 1) {
    const candidate = join(directory, `${name}.legacy-${suffix}${index === 0 ? "" : `-${index}`}`);
    if (!existsSync(candidate)) {
      return candidate;
    }
  }
}

async function checkpointLegacyMemory(path: string): Promise<void> {
  if (!existsSync(path)) {
    return;
  }
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    database.close();
  }
}

async function writeWorkspaceMetadata(paths: YikuPaths, now: Date): Promise<void> {
  const rootRealPath = await realpath(paths.workspaceDir);
  const content = `${JSON.stringify(
    {
      migrationVersion: MIGRATION_VERSION,
      migratedAt: now.toISOString(),
      rootRealPath,
      workspaceDir: paths.workspaceDir,
    },
    null,
    2,
  )}\n`;
  const temporaryPath = `${paths.workspaceMetadataFilePath}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporaryPath, paths.workspaceMetadataFilePath);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function removeIfEmpty(path: string): Promise<void> {
  if ((await readdir(path)).length === 0) {
    await rm(path, { force: true, recursive: true });
  }
}

async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveDigest, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolveDigest);
  });
  return hash.digest("hex");
}
