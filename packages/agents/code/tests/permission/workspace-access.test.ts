import { describe, expect, it, vi } from "vitest";
import {
  WorkspaceAccessController,
  WorkspaceWriteAccessDeniedError,
} from "../../src/permission/workspace-access.js";

const request = {
  action: "edit" as const,
  subject: "src/index.ts",
  workspaceId: "workspace-1",
};

describe("WorkspaceAccessController", () => {
  it("defaults to read-write access", async () => {
    const controller = new WorkspaceAccessController();

    expect(controller.accessMode).toBe("read-write");
    await expect(controller.requireWrite(request)).resolves.toBeUndefined();
  });

  it("does not ask when the Session already has write access", async () => {
    const approvalHandler = vi.fn();
    const controller = new WorkspaceAccessController({
      accessMode: "read-write",
      approvalHandler,
    });

    await expect(controller.requireWrite(request)).resolves.toBeUndefined();
    expect(approvalHandler).not.toHaveBeenCalled();
  });

  it("upgrades a read-only Session once and reuses the decision", async () => {
    const approvalHandler = vi.fn(async () => ({
      decision: "allow" as const,
      persistence: "session" as const,
    }));
    const controller = new WorkspaceAccessController({
      accessMode: "read-only",
      approvalHandler,
    });

    await Promise.all([controller.requireWrite(request), controller.requireWrite(request)]);
    await controller.requireWrite(request);

    expect(controller.accessMode).toBe("read-write");
    expect(approvalHandler).toHaveBeenCalledOnce();
  });

  it("fails closed without approval and can retry after denial", async () => {
    const approvalHandler = vi
      .fn()
      .mockResolvedValueOnce({ decision: "deny", reason: "No edit." })
      .mockResolvedValueOnce({ decision: "allow", persistence: "persistent" });
    const controller = new WorkspaceAccessController({
      accessMode: "read-only",
      approvalHandler,
    });

    await expect(controller.requireWrite(request)).rejects.toEqual(
      new WorkspaceWriteAccessDeniedError("No edit."),
    );
    await expect(controller.requireWrite(request)).resolves.toBeUndefined();
    expect(approvalHandler).toHaveBeenCalledTimes(2);
  });

  it("uses the default denial reason and accepts a handler installed later", async () => {
    const controller = new WorkspaceAccessController({
      accessMode: "read-only",
    });

    await expect(controller.requireWrite(request)).rejects.toThrow(
      "Workspace write access was not granted.",
    );
    controller.setApprovalHandler(() => ({
      decision: "allow",
      persistence: "session",
    }));
    await expect(controller.requireWrite(request)).resolves.toBeUndefined();
  });
});
