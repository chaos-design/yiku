export type WorkspaceAccessMode = "read-only" | "read-write";
export type WorkspaceAccessPersistence = "persistent" | "session";

export interface WorkspaceWriteAccessRequest {
  readonly action: "edit" | "shell";
  readonly subject: string;
  readonly workspaceId: string;
}

export type WorkspaceWriteAccessResponse =
  | {
      readonly decision: "allow";
      readonly persistence: WorkspaceAccessPersistence;
    }
  | {
      readonly decision: "deny";
      readonly reason?: string | undefined;
    };

export type WorkspaceWriteAccessApprovalHandler = (
  request: WorkspaceWriteAccessRequest,
) => Promise<WorkspaceWriteAccessResponse> | WorkspaceWriteAccessResponse;

export interface WorkspaceAccessControllerOptions {
  readonly accessMode?: WorkspaceAccessMode | undefined;
  readonly approvalHandler?: WorkspaceWriteAccessApprovalHandler | undefined;
}

export class WorkspaceWriteAccessDeniedError extends Error {
  public override readonly name = "WorkspaceWriteAccessDeniedError";
}

export class WorkspaceAccessController {
  private mode: WorkspaceAccessMode;
  private approvalHandler?: WorkspaceWriteAccessApprovalHandler | undefined;
  private pendingUpgrade?: Promise<void> | undefined;

  public constructor(options: WorkspaceAccessControllerOptions = {}) {
    this.mode = options.accessMode ?? "read-write";
    this.approvalHandler = options.approvalHandler;
  }

  public get accessMode(): WorkspaceAccessMode {
    return this.mode;
  }

  public setApprovalHandler(
    approvalHandler: WorkspaceWriteAccessApprovalHandler | undefined,
  ): void {
    this.approvalHandler = approvalHandler;
  }

  public requireWrite(request: WorkspaceWriteAccessRequest): Promise<void> {
    if (this.mode === "read-write") {
      return Promise.resolve();
    }
    this.pendingUpgrade ??= this.requestUpgrade(request).finally(() => {
      this.pendingUpgrade = undefined;
    });
    return this.pendingUpgrade;
  }

  private async requestUpgrade(request: WorkspaceWriteAccessRequest): Promise<void> {
    const response = await this.approvalHandler?.(request);
    if (response?.decision !== "allow") {
      throw new WorkspaceWriteAccessDeniedError(
        response?.reason?.trim() || "Workspace write access was not granted.",
      );
    }
    this.mode = "read-write";
  }
}
