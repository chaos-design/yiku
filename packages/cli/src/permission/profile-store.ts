import { chmod, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  createDefaultPermissionProfileDocument,
  type PermissionProfile,
  type PermissionProfileDocument,
  PermissionProfileValidationError,
  type PermissionRuleDecision,
  parsePermissionProfileDocument,
  type WorkspaceAccessMode,
  type WorkspaceAuthorizationRecord,
} from "./profile-schema.js";

export interface PermissionProfileStoreOptions {
  readonly filePath?: string | undefined;
  readonly homeDir?: string | undefined;
}

export interface ResolvedWorkspaceAuthorization {
  readonly accessMode: WorkspaceAccessMode;
  readonly expiresAt: string;
  readonly grantedAt: string;
  readonly workspaceDir: string;
}

export class PermissionProfileStore {
  public readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(options: PermissionProfileStoreOptions = {}) {
    this.filePath = resolve(
      options.filePath ??
        join(resolve(options.homeDir ?? homedir()), ".yiku", "permission", "global.json"),
    );
  }

  public async load(): Promise<PermissionProfileDocument> {
    try {
      const value: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      const document = parsePermissionProfileDocument(value);
      if (readMigrationVersion(value) !== document._migrationVersion) {
        await this.writeDocument(document);
      }
      return document;
    } catch (error) {
      if (!isFileMissing(error)) {
        if (error instanceof PermissionProfileValidationError) {
          throw error;
        }
        throw new PermissionProfileValidationError(
          `Unable to parse permission profile ${this.filePath}.`,
        );
      }
    }

    const document = createDefaultPermissionProfileDocument();
    await this.writeDocument(document);
    return document;
  }

  public async reset(): Promise<PermissionProfileDocument> {
    return this.mutate(async () => {
      const document = createDefaultPermissionProfileDocument();
      await this.writeDocument(document);
      return document;
    });
  }

  public async getWorkspaceAuthorization(
    workspaceDir: string,
    now = new Date(),
  ): Promise<ResolvedWorkspaceAuthorization | undefined> {
    const canonical = await canonicalWorkspaceDir(workspaceDir);
    const document = await this.load();
    const filesystem = document.resourceAuthorization.filesystem;

    return (
      findAuthorization(filesystem.readWrite, canonical, "read-write", now) ??
      findAuthorization(filesystem.readOnly, canonical, "read-only", now)
    );
  }

  public async authorizeWorkspace(
    workspaceDir: string,
    accessMode: WorkspaceAccessMode,
    now = new Date(),
  ): Promise<ResolvedWorkspaceAuthorization> {
    return this.mutate(async () => {
      const canonical = await canonicalWorkspaceDir(workspaceDir);
      const document = await this.load();
      const ttlDays = activeProfile(document).authorization.ttlDays;
      const authorization: WorkspaceAuthorizationRecord = {
        expiresAt: new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1_000).toISOString(),
        grantedAt: now.toISOString(),
        path: resolve(workspaceDir),
        rootRealPath: canonical,
      };
      const readOnly = activeAuthorizations(
        document.resourceAuthorization.filesystem.readOnly,
        canonical,
        now,
      );
      const readWrite = activeAuthorizations(
        document.resourceAuthorization.filesystem.readWrite,
        canonical,
        now,
      );
      const next: PermissionProfileDocument = {
        ...document,
        resourceAuthorization: {
          ...document.resourceAuthorization,
          filesystem: {
            readOnly: accessMode === "read-only" ? [authorization, ...readOnly] : readOnly,
            readWrite: accessMode === "read-write" ? [authorization, ...readWrite] : readWrite,
          },
        },
      };
      await this.writeDocument(next);
      return {
        accessMode,
        expiresAt: authorization.expiresAt,
        grantedAt: authorization.grantedAt,
        workspaceDir: canonical,
      };
    });
  }

  public async setPolicyRule(policyId: string, decision: PermissionRuleDecision): Promise<void> {
    const normalizedPolicyId = policyId.trim();
    if (!normalizedPolicyId) {
      throw new Error("Permission Policy ID must be non-empty.");
    }

    await this.mutate(async () => {
      const document = await this.load();
      const profile = activeProfile(document);
      const nextProfile: PermissionProfile = {
        ...profile,
        approval: {
          ...profile.approval,
          policyRules: {
            ...profile.approval.policyRules,
            [normalizedPolicyId]: decision,
          },
        },
      };
      await this.writeDocument({
        ...document,
        profiles: {
          ...document.profiles,
          [document.activeProfile]: nextProfile,
        },
      });
    });
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async writeDocument(document: PermissionProfileDocument): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { mode: 0o700, recursive: true });
    await chmod(directory, 0o700);
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);

    try {
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
    await handle.close();

    try {
      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, 0o600);
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function readMigrationVersion(value: unknown): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)._migrationVersion
    : undefined;
}

function activeProfile(document: PermissionProfileDocument): PermissionProfile {
  return document.profiles[document.activeProfile] as PermissionProfile;
}

function findAuthorization(
  records: readonly WorkspaceAuthorizationRecord[],
  canonical: string,
  accessMode: WorkspaceAccessMode,
  now: Date,
): ResolvedWorkspaceAuthorization | undefined {
  const record = records.find(
    (item) => item.rootRealPath === canonical && Date.parse(item.expiresAt) > now.getTime(),
  );
  return record === undefined
    ? undefined
    : {
        accessMode,
        expiresAt: record.expiresAt,
        grantedAt: record.grantedAt,
        workspaceDir: canonical,
      };
}

function activeAuthorizations(
  records: readonly WorkspaceAuthorizationRecord[],
  excludedCanonicalPath: string,
  now: Date,
): readonly WorkspaceAuthorizationRecord[] {
  return records.filter(
    (item) =>
      item.rootRealPath !== excludedCanonicalPath && Date.parse(item.expiresAt) > now.getTime(),
  );
}

async function canonicalWorkspaceDir(workspaceDir: string): Promise<string> {
  try {
    return await realpath(workspaceDir);
  } catch {
    return resolve(workspaceDir);
  }
}

function isFileMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
