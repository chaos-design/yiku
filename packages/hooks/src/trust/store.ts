import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { HookTrustError } from "../errors.js";
import { createTrustKey, type HookTrustDescriptor } from "./canonical.js";
import type {
  HookTrustDocument,
  HookTrustEntry,
  HookTrustStoreContract,
  HookTrustStoreOptions,
} from "./types.js";

export class HookTrustStore implements HookTrustStoreContract {
  private entries = new Map<string, HookTrustEntry>();
  private initialized = false;
  private readonly now: () => Date;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(private readonly options: HookTrustStoreOptions) {
    if (!isAbsolute(options.filePath)) {
      throw new HookTrustError("HOOK_CONFIG_INVALID", "Hook trust store path must be absolute.");
    }
    this.now = options.now ?? (() => new Date());
  }

  public approve(descriptor: HookTrustDescriptor): Promise<HookTrustEntry> {
    return this.enqueue(async () => {
      await this.initialize();
      const key = createTrustKey(descriptor);
      const current = this.entries.get(key);

      if (current !== undefined) {
        return current;
      }

      const entry = Object.freeze({
        approvedAt: this.now().toISOString(),
        descriptor: deepFreeze(structuredClone(descriptor)),
        key,
      });
      const next = new Map(this.entries);
      next.set(key, entry);
      await this.persist(next);
      this.entries = next;
      return entry;
    });
  }

  public async has(descriptor: HookTrustDescriptor): Promise<boolean> {
    await this.initialize();
    return this.entries.has(createTrustKey(descriptor));
  }

  public async list(): Promise<readonly HookTrustEntry[]> {
    await this.initialize();
    return Object.freeze(
      [...this.entries.values()].sort((left, right) => left.key.localeCompare(right.key)),
    );
  }

  public revoke(key: string): Promise<boolean> {
    return this.enqueue(async () => {
      await this.initialize();

      if (!this.entries.has(key)) {
        return false;
      }

      const next = new Map(this.entries);
      next.delete(key);
      await this.persist(next);
      this.entries = next;
      return true;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    let content: string;
    try {
      content = await readFile(this.options.filePath, "utf8");
    } catch (error) {
      if (isNotFoundError(error)) {
        this.initialized = true;
        return;
      }
      throw trustStoreError("Unable to read Hook trust store.", error);
    }

    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch (error) {
      throw trustStoreError("Hook trust store contains invalid JSON.", error);
    }

    const document = validateDocument(value);
    this.entries = new Map(document.entries.map((entry) => [entry.key, entry]));
    this.initialized = true;
  }

  private async persist(entries: ReadonlyMap<string, HookTrustEntry>): Promise<void> {
    const directory = dirname(this.options.filePath);
    const temporaryPath = `${this.options.filePath}.${randomUUID()}.tmp`;
    const document: HookTrustDocument = {
      entries: [...entries.values()].sort((left, right) => left.key.localeCompare(right.key)),
      version: 1,
    };
    let handle: Awaited<ReturnType<typeof open>> | undefined;

    try {
      await mkdir(directory, { mode: 0o700, recursive: true });
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.options.filePath);
      await chmod(this.options.filePath, 0o600);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw trustStoreError("Unable to persist Hook trust store.", error);
    }
  }
}

function validateDocument(value: unknown): HookTrustDocument {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries)) {
    throw trustStoreError("Hook trust store has an unsupported structure.");
  }

  const entries = value.entries.map(validateEntry);
  return {
    entries,
    version: 1,
  };
}

function validateEntry(value: unknown): HookTrustEntry {
  if (
    !isRecord(value) ||
    typeof value.approvedAt !== "string" ||
    typeof value.key !== "string" ||
    !isRecord(value.descriptor)
  ) {
    throw trustStoreError("Hook trust store contains an invalid entry.");
  }

  const descriptor = value.descriptor as unknown as HookTrustDescriptor;

  if (createTrustKey(descriptor) !== value.key) {
    throw trustStoreError("Hook trust store entry hash does not match its descriptor.");
  }

  return deepFreeze({
    approvedAt: value.approvedAt,
    descriptor,
    key: value.key,
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}

function trustStoreError(message: string, cause?: unknown): HookTrustError {
  return new HookTrustError("HOOK_SECURITY_REJECTED", message, {
    ...(cause !== undefined ? { cause } : {}),
  });
}

function isNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
