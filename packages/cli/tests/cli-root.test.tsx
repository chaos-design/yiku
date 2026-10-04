import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import type { ExecuteAgentSessionOptions } from "../src/agent-session.js";
import {
  UserInteractionController,
  type UserInteractionState,
  type WorkspaceAccessMode,
} from "../src/app/user-interaction.js";
import { CliRoot } from "../src/cli-root.js";
import type { WorkspaceTrustRecord, WorkspaceTrustStoreContract } from "../src/workspace-trust.js";

describe("CliRoot", () => {
  it("does not mount the App or submit a prompt before workspace trust", async () => {
    const runPromptImpl = vi.fn(async () => "not called");
    const app = render(
      <CliRoot
        prompt="inspect"
        runPromptImpl={runPromptImpl}
        workspaceDir="/workspace/project"
        workspaceTrustStore={new MemoryWorkspaceTrustStore()}
      />,
    );

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("授权当前工作区");
    });
    expect(app.lastFrame()).toContain("/workspace/project");
    expect(app.lastFrame()).not.toContain("Yiku Session");
    expect(runPromptImpl).not.toHaveBeenCalled();
    app.unmount();
  });

  it("mounts the App with read-write access after one-time trust", async () => {
    const interaction = interactionFixture();
    const runPromptImpl = vi.fn(
      async (_prompt: string, _options?: ExecuteAgentSessionOptions) => "completed",
    );
    const app = render(
      <CliRoot
        autoExit={false}
        createUserInteractionController={interaction.create}
        prompt="inspect"
        runPromptImpl={runPromptImpl}
        workspaceDir="/workspace/project"
        workspaceTrustStore={new MemoryWorkspaceTrustStore()}
      />,
    );

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("授权当前工作区");
    });
    interaction.get().select(0);
    interaction.get().confirm();

    await vi.waitFor(() => {
      expect(runPromptImpl).toHaveBeenCalledWith(
        "inspect",
        expect.objectContaining({
          accessMode: "read-write",
        }),
      );
    });
    app.unmount();
  });

  it("mounts the App immediately when workspace trust is still valid", async () => {
    const interaction = interactionFixture();
    const store = new MemoryWorkspaceTrustStore({
      accessMode: "read-write",
      expiresAt: "2026-08-10T00:00:00.000Z",
      trustedAt: "2026-08-03T00:00:00.000Z",
      workspaceDir: "/workspace/project",
    });
    const runPromptImpl = vi.fn(
      async (_prompt: string, _options?: ExecuteAgentSessionOptions) => "completed",
    );
    const app = render(
      <CliRoot
        autoExit={false}
        createUserInteractionController={interaction.create}
        prompt="inspect"
        runPromptImpl={runPromptImpl}
        workspaceDir="/workspace/project"
        workspaceTrustStore={store}
      />,
    );

    await vi.waitFor(() => {
      expect(runPromptImpl).toHaveBeenCalledWith(
        "inspect",
        expect.objectContaining({
          accessMode: "read-write",
        }),
      );
    });
    expect(app.lastFrame()).not.toContain("授权当前工作区");
    app.unmount();
  });

  it("asks again when a legacy workspace authorization is read-only", async () => {
    const interaction = interactionFixture();
    const runPromptImpl = vi.fn(async () => "not called");
    const store = new MemoryWorkspaceTrustStore({
      accessMode: "read-only",
      expiresAt: "2026-08-10T00:00:00.000Z",
      trustedAt: "2026-08-03T00:00:00.000Z",
      workspaceDir: "/workspace/project",
    });
    const app = render(
      <CliRoot
        createUserInteractionController={interaction.create}
        prompt="inspect"
        runPromptImpl={runPromptImpl}
        workspaceDir="/workspace/project"
        workspaceTrustStore={store}
      />,
    );

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("授权当前工作区");
    });
    expect(runPromptImpl).not.toHaveBeenCalled();
    app.unmount();
  });

  it("persists workspace trust when full read-write trust is selected", async () => {
    const interaction = interactionFixture();
    const store = new MemoryWorkspaceTrustStore();
    const runPromptImpl = vi.fn(
      async (_prompt: string, _options?: ExecuteAgentSessionOptions) => "completed",
    );
    const app = render(
      <CliRoot
        autoExit={false}
        createUserInteractionController={interaction.create}
        prompt="inspect"
        runPromptImpl={runPromptImpl}
        workspaceDir="/workspace/project"
        workspaceTrustStore={store}
      />,
    );

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("授权当前工作区");
    });
    interaction.get().select(1);
    interaction.get().confirm();

    await vi.waitFor(() => {
      expect(runPromptImpl).toHaveBeenCalledWith(
        "inspect",
        expect.objectContaining({
          accessMode: "read-write",
        }),
      );
    });
    expect(store.trusted).toMatchObject({
      accessMode: "read-write",
      workspaceDir: "/workspace/project",
    });
    app.unmount();
  });

  it("exits without mounting the App when trust is rejected", async () => {
    const interaction = interactionFixture();
    const onExitCode = vi.fn();
    const runPromptImpl = vi.fn(async () => "not called");
    const app = render(
      <CliRoot
        createUserInteractionController={interaction.create}
        onExitCode={onExitCode}
        prompt="inspect"
        runPromptImpl={runPromptImpl}
        workspaceDir="/workspace/project"
        workspaceTrustStore={new MemoryWorkspaceTrustStore()}
      />,
    );

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("授权当前工作区");
    });
    interaction.get().select(2);
    interaction.get().confirm();

    await vi.waitFor(() => {
      expect(onExitCode).toHaveBeenCalledWith(0);
    });
    expect(runPromptImpl).not.toHaveBeenCalled();
  });

  it("fails closed when the Permission Profile cannot be loaded", async () => {
    const onExitCode = vi.fn();
    const runPromptImpl = vi.fn(async () => "not called");
    const app = render(
      <CliRoot
        onExitCode={onExitCode}
        prompt="inspect"
        runPromptImpl={runPromptImpl}
        workspaceDir="/workspace/project"
        workspaceTrustStore={{
          get: async () => {
            throw new Error("Permission profile is corrupt.");
          },
          trust: async () => {
            throw new Error("not called");
          },
        }}
      />,
    );

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain(
        "Workspace authorization failed: Permission profile is corrupt.",
      );
    });
    expect(onExitCode).toHaveBeenCalledWith(1);
    expect(runPromptImpl).not.toHaveBeenCalled();
    app.unmount();
  });
});

function interactionFixture() {
  let controller: UserInteractionController | undefined;

  return {
    create: (onStateChange: (state: UserInteractionState | undefined) => void) => {
      controller = new UserInteractionController({ onStateChange });
      return controller;
    },
    current: () => controller,
    get: () => {
      if (controller === undefined) {
        throw new Error("Expected CliRoot to create a UserInteractionController.");
      }
      return controller;
    },
  };
}

class MemoryWorkspaceTrustStore implements WorkspaceTrustStoreContract {
  public trusted?: WorkspaceTrustRecord | undefined;

  public constructor(trusted?: WorkspaceTrustRecord | undefined) {
    this.trusted = trusted;
  }
  public async get(): Promise<WorkspaceTrustRecord | undefined> {
    return this.trusted;
  }

  public async trust(
    workspaceDir: string,
    accessMode: WorkspaceAccessMode,
  ): Promise<WorkspaceTrustRecord> {
    const record = {
      accessMode,
      expiresAt: "2026-08-10T00:00:00.000Z",
      trustedAt: "2026-08-03T00:00:00.000Z",
      workspaceDir,
    };
    this.trusted = record;
    return record;
  }
}
