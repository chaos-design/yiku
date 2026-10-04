import { homedir } from "node:os";
import { resolve } from "node:path";
import type { WorkspaceAccessMode } from "./app/user-interaction.js";
import { PermissionProfileStore } from "./permission/profile-store.js";

export interface WorkspaceTrustRecord {
  readonly accessMode: WorkspaceAccessMode;
  readonly expiresAt: string;
  readonly trustedAt: string;
  readonly workspaceDir: string;
}

export interface WorkspaceTrustStoreContract {
  get(workspaceDir: string, now?: Date): Promise<WorkspaceTrustRecord | undefined>;
  trust(
    workspaceDir: string,
    accessMode: WorkspaceAccessMode,
    now?: Date,
  ): Promise<WorkspaceTrustRecord>;
}

export class WorkspaceTrustStore implements WorkspaceTrustStoreContract {
  private readonly store: PermissionProfileStore;

  public constructor(filePath = workspaceTrustFilePath()) {
    this.store = new PermissionProfileStore({ filePath });
  }

  public async get(
    workspaceDir: string,
    now = new Date(),
  ): Promise<WorkspaceTrustRecord | undefined> {
    const authorization = await this.store.getWorkspaceAuthorization(workspaceDir, now);
    return authorization === undefined
      ? undefined
      : {
          accessMode: authorization.accessMode,
          expiresAt: authorization.expiresAt,
          trustedAt: authorization.grantedAt,
          workspaceDir: authorization.workspaceDir,
        };
  }

  public async trust(
    workspaceDir: string,
    accessMode: WorkspaceAccessMode,
    now = new Date(),
  ): Promise<WorkspaceTrustRecord> {
    const authorization = await this.store.authorizeWorkspace(workspaceDir, accessMode, now);
    return {
      accessMode: authorization.accessMode,
      expiresAt: authorization.expiresAt,
      trustedAt: authorization.grantedAt,
      workspaceDir: authorization.workspaceDir,
    };
  }
}

export function workspaceTrustFilePath(homeDir = homedir()): string {
  return resolve(homeDir, ".yiku", "permission", "global.json");
}
