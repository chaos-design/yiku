import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { parse } from "yaml";
import type { ModelsConfig } from "./models.js";
import { serializeModelsConfig } from "./models.js";

export interface ConfigStoreOptions {
  readonly beforeCommit?: (() => Promise<void> | void) | undefined;
  readonly filePath: string;
}

interface ConfigSnapshot {
  readonly config: ModelsConfig;
  readonly revision: string | undefined;
}

export class ConfigRevisionConflictError extends Error {
  public constructor(public readonly filePath: string) {
    super(`Config changed before commit: ${filePath}`);
    this.name = "ConfigRevisionConflictError";
  }
}

export class ConfigStore {
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(private readonly options: ConfigStoreOptions) {
    if (!isAbsolute(options.filePath)) {
      throw new Error("ConfigStore filePath must be absolute.");
    }
  }

  public load(): Promise<ModelsConfig> {
    return this.enqueue(async () => (await readSnapshot(this.options.filePath)).config);
  }

  public set(path: readonly string[], value: unknown): Promise<ModelsConfig> {
    return this.enqueue(async () => {
      validateConfigPath(path);
      const snapshot = await readSnapshot(this.options.filePath);
      const config = setConfigValue(snapshot.config, path, value);
      await this.commit(config, snapshot.revision);
      return config;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async commit(config: ModelsConfig, expectedRevision: string | undefined): Promise<void> {
    const directory = dirname(this.options.filePath);
    const temporaryPath = join(
      directory,
      `.${basename(this.options.filePath)}.${randomUUID()}.tmp`,
    );
    let file: Awaited<ReturnType<typeof open>> | undefined;
    let directoryHandle: Awaited<ReturnType<typeof open>> | undefined;

    try {
      await mkdir(directory, { mode: 0o700, recursive: true });
      file = await open(temporaryPath, "wx", 0o600);
      await file.writeFile(serializeModelsConfig(config), "utf8");
      await file.sync();
      await file.close();
      file = undefined;

      await this.options.beforeCommit?.();
      const currentRevision = await readRevision(this.options.filePath);
      if (currentRevision !== expectedRevision) {
        throw new ConfigRevisionConflictError(this.options.filePath);
      }

      await rename(temporaryPath, this.options.filePath);
      directoryHandle = await open(directory, "r");
      await directoryHandle.sync();
      await directoryHandle.close();
      directoryHandle = undefined;
      await chmod(this.options.filePath, 0o600);
    } catch (error) {
      await file?.close().catch(() => undefined);
      await directoryHandle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

async function readSnapshot(filePath: string): Promise<ConfigSnapshot> {
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return { config: {}, revision: undefined };
    }
    throw error;
  }

  const value: unknown = parse(bytes.toString("utf8"));
  return {
    config: isRecord(value) ? value : {},
    revision: hashBytes(bytes),
  };
}

async function readRevision(filePath: string): Promise<string | undefined> {
  try {
    return hashBytes(await readFile(filePath));
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function setConfigValue(
  config: ModelsConfig,
  path: readonly string[],
  value: unknown,
): ModelsConfig {
  const result: ModelsConfig = { ...config };
  let source = config;
  let target = result;

  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index] as string;
    const existing = Object.hasOwn(source, segment) ? source[segment] : undefined;
    if (existing !== undefined && !isRecord(existing)) {
      throw new TypeError(
        `Config path cannot traverse non-record segment: ${JSON.stringify(path.slice(0, index + 1))}`,
      );
    }

    const next = existing === undefined ? {} : { ...existing };
    setOwnProperty(target, segment, next);
    source = existing ?? next;
    target = next;
  }

  setOwnProperty(target, path[path.length - 1] as string, value);
  return result;
}

function setOwnProperty(target: ModelsConfig, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function validateConfigPath(path: readonly string[]): void {
  if (path.length === 0 || path.some((segment) => segment.trim().length === 0)) {
    throw new Error("ConfigStore path must contain non-empty segments.");
  }
}

function isRecord(value: unknown): value is ModelsConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
