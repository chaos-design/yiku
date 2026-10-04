import { createInitialSessionState, type SessionState } from "@yiku/agent-orchestrator";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { CheckpointPicker } from "../../src/app/checkpoint-picker.js";
import { CommandOverlayView } from "../../src/app/command-overlay.js";
import { McpManager } from "../../src/app/mcp-manager.js";
import { ModelPicker } from "../../src/app/model-picker.js";
import { OutputStylePicker } from "../../src/app/output-style-picker.js";
import { SessionPicker } from "../../src/app/session-picker.js";
import type {
  CheckpointPickerOverlay,
  McpManagerOverlay,
  ModelPickerOverlay,
  OutputStylePickerOverlay,
  SessionPickerOverlay,
  SlashCommandResult,
} from "../../src/slash-commands/types.js";

describe("SessionPicker", () => {
  it("searches, pages, selects, and cancels", async () => {
    const onCancel = vi.fn();
    const onResult = vi.fn();
    const onSelect = vi.fn(async (id: string) => success(`selected ${id}`));
    const app = render(
      <SessionPicker
        onCancel={onCancel}
        onResult={onResult}
        overlay={sessionOverlay({ onSelect, sessions: sessionStates(12) })}
      />,
    );

    expect(app.lastFrame()).toContain("1-10/12");
    app.stdin.write("\u001B[B");
    await vi.waitFor(() => expect(selectedLine(app.lastFrame(), "session-2")).toContain("›"));
    app.stdin.write("\r");
    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith("session-2"));
    expect(onResult).toHaveBeenCalledWith(success("selected session-2"));
    app.unmount();

    const searchApp = render(
      <SessionPicker
        onCancel={onCancel}
        onResult={onResult}
        overlay={sessionOverlay({ sessions: sessionStates(12) })}
      />,
    );
    searchApp.stdin.write("1");
    await vi.waitFor(() => expect(searchApp.lastFrame()).toContain("Search: 1"));
    searchApp.stdin.write("2");
    await vi.waitFor(() => {
      expect(searchApp.lastFrame()).toContain("session-12");
      expect(searchApp.lastFrame()).not.toContain("Session 1 ·");
    });
    searchApp.stdin.write("\u007F");
    await vi.waitFor(() => expect(searchApp.lastFrame()).toContain("session-10"));
    searchApp.stdin.write("\u001B");
    await vi.waitFor(() => expect(onCancel).toHaveBeenCalled());
    searchApp.unmount();
  });

  it("renames, deletes, reports errors, and renders empty results", async () => {
    const onCancel = vi.fn();
    const onResult = vi.fn();
    const onRename = vi.fn(async (_id: string, title: string) => success(`renamed ${title}`));
    const onDelete = vi.fn(async (id: string) => success(`deleted ${id}`));
    const app = render(
      <SessionPicker
        onCancel={onCancel}
        onResult={onResult}
        overlay={sessionOverlay({ onDelete, onRename, sessions: sessionStates(2) })}
      />,
    );

    app.stdin.write("\u0012");
    await vi.waitFor(() => expect(app.lastFrame()).toContain("Rename: Session 1"));
    app.stdin.write("\u007F");
    app.stdin.write("X");
    await vi.waitFor(() => expect(app.lastFrame()).toContain("Rename: Session X"));
    app.stdin.write("\r");
    await vi.waitFor(() => expect(onRename).toHaveBeenCalledWith("session-1", "Session X"));
    app.unmount();

    const deleteApp = render(
      <SessionPicker
        onCancel={onCancel}
        onResult={onResult}
        overlay={sessionOverlay({ onDelete, sessions: sessionStates(2) })}
      />,
    );
    deleteApp.stdin.write("d");
    await vi.waitFor(() => expect(deleteApp.lastFrame()).toContain("Delete session-1? [y/N]"));
    deleteApp.stdin.write("n");
    await vi.waitFor(() => expect(deleteApp.lastFrame()).not.toContain("[y/N]"));
    deleteApp.stdin.write("d");
    await vi.waitFor(() => expect(deleteApp.lastFrame()).toContain("[y/N]"));
    deleteApp.stdin.write("y");
    await vi.waitFor(() => expect(onDelete).toHaveBeenCalledWith("session-1"));
    deleteApp.unmount();

    const errorApp = render(
      <SessionPicker
        onCancel={onCancel}
        onResult={onResult}
        overlay={sessionOverlay({
          onSelect: async () => {
            throw new Error("resume failed");
          },
          sessions: sessionStates(1),
        })}
      />,
    );
    errorApp.stdin.write("\r");
    await vi.waitFor(() =>
      expect(onResult).toHaveBeenCalledWith({
        kind: "error",
        message: "resume failed",
        title: "Command Error",
      }),
    );
    errorApp.unmount();

    const emptyApp = render(
      <SessionPicker
        onCancel={onCancel}
        onResult={onResult}
        overlay={sessionOverlay({ sessions: [] })}
      />,
    );
    expect(emptyApp.lastFrame()).toContain("No Sessions found.");
    emptyApp.unmount();
  });
});

describe("CheckpointPicker", () => {
  it("pages, selects, handles errors, and cancels", async () => {
    const onCancel = vi.fn();
    const onResult = vi.fn();
    const onSelect = vi.fn(async (id: string) => success(`rewound ${id}`));
    const checkpoints = Array.from({ length: 12 }, (_, index) =>
      checkpoint(`checkpoint-${index + 1}`, index),
    );
    const overlay: CheckpointPickerOverlay = {
      checkpoints,
      kind: "checkpoint-picker",
      onSelect,
      title: "Checkpoints",
    };
    const app = render(
      <CheckpointPicker onCancel={onCancel} onResult={onResult} overlay={overlay} />,
    );

    expect(app.lastFrame()).toContain("1-10/12");
    expect(app.lastFrame()).toContain("1 files · 1.0 KiB");
    app.stdin.write("\u001B[B");
    await vi.waitFor(() => expect(selectedLine(app.lastFrame(), "prompt 2")).toContain("›"));
    app.stdin.write("\r");
    expect(onSelect).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(app.lastFrame()).toContain("Press Enter again to confirm"));
    app.stdin.write("\r");
    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith("checkpoint-2"));
    await vi.waitFor(() => expect(onResult).toHaveBeenCalled());
    await vi.waitFor(() => expect(app.lastFrame()).not.toContain("Press Enter again to confirm"));
    app.stdin.write("\u001B");
    await vi.waitFor(() => expect(onCancel).toHaveBeenCalled());
    app.unmount();

    const errorApp = render(
      <CheckpointPicker
        onCancel={onCancel}
        onResult={onResult}
        overlay={{
          ...overlay,
          checkpoints: [checkpoint("broken", 0)],
          onSelect: async () => {
            throw "restore failed";
          },
        }}
      />,
    );
    errorApp.stdin.write("\r");
    await vi.waitFor(() => expect(errorApp.lastFrame()).toContain("Press Enter again to confirm"));
    errorApp.stdin.write("\r");
    await vi.waitFor(() =>
      expect(onResult).toHaveBeenCalledWith({
        kind: "error",
        message: "restore failed",
        title: "Command Error",
      }),
    );
    errorApp.unmount();

    const emptyApp = render(
      <CheckpointPicker
        onCancel={onCancel}
        onResult={onResult}
        overlay={{ ...overlay, checkpoints: [] }}
      />,
    );
    expect(emptyApp.lastFrame()).toContain("No checkpoints available.");
    emptyApp.unmount();
  });
});

describe("ModelPicker", () => {
  it("filters, changes scope, selects, handles errors, and cancels", async () => {
    const onCancel = vi.fn();
    const onResult = vi.fn();
    const onSelect = vi.fn(async (key: string, options: { readonly global: boolean }) =>
      success(`${key}:${options.global}`),
    );
    const overlay: ModelPickerOverlay = {
      currentModel: "code",
      kind: "model-picker",
      models: [
        { key: "code", model: "gpt-code", provider: "openai" },
        { key: "reasoning", model: "claude-reasoning", provider: "anthropic" },
      ],
      onSelect,
      title: "Models",
    };
    const app = render(<ModelPicker onCancel={onCancel} onResult={onResult} overlay={overlay} />);

    expect(app.lastFrame()).toContain("OPENAI");
    expect(app.lastFrame()).toContain("ANTHROPIC");
    expect(app.lastFrame()).toContain("code · gpt-code · current");
    expect(app.lastFrame()).not.toContain("gpt-code · openai");
    app.stdin.write("reason");
    await vi.waitFor(() => {
      expect(app.lastFrame()).not.toContain("gpt-code");
      expect(app.lastFrame()).not.toContain("OPENAI");
      expect(app.lastFrame()).toContain("ANTHROPIC");
    });
    app.stdin.write("\u007F");
    app.stdin.write("g");
    await vi.waitFor(() => expect(app.lastFrame()).toContain("scope: global default"));
    app.stdin.write("\r");
    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith("reasoning", { global: true }));
    app.stdin.write("\u001B");
    await vi.waitFor(() => expect(onCancel).toHaveBeenCalled());
    app.unmount();

    const errorApp = render(
      <ModelPicker
        onCancel={onCancel}
        onResult={onResult}
        overlay={{
          ...overlay,
          models: [{ key: "broken", model: "broken" }],
          onSelect: async () => {
            throw new Error("model failed");
          },
        }}
      />,
    );
    errorApp.stdin.write("\r");
    await vi.waitFor(() =>
      expect(onResult).toHaveBeenCalledWith({
        kind: "error",
        message: "model failed",
        title: "Command Error",
      }),
    );
    errorApp.unmount();
    const stringErrorApp = render(
      <ModelPicker
        onCancel={onCancel}
        onResult={onResult}
        overlay={{
          ...overlay,
          models: [{ key: "broken-string", model: "broken-string" }],
          onSelect: async () => {
            throw "string model failure";
          },
        }}
      />,
    );
    stringErrorApp.stdin.write("\r");
    await vi.waitFor(() =>
      expect(onResult).toHaveBeenCalledWith({
        kind: "error",
        message: "string model failure",
        title: "Command Error",
      }),
    );
    stringErrorApp.unmount();
    const emptyApp = render(
      <ModelPicker onCancel={onCancel} onResult={onResult} overlay={{ ...overlay, models: [] }} />,
    );
    expect(emptyApp.lastFrame()).toContain("No models found.");
    emptyApp.unmount();
  });

  it("groups interleaved models by provider in first-seen order", () => {
    const app = render(
      <ModelPicker
        onCancel={vi.fn()}
        onResult={vi.fn()}
        overlay={{
          currentModel: "openai-a",
          kind: "model-picker",
          models: [
            { key: "openai-a", model: "gpt-a", provider: "openai" },
            { key: "anthropic-a", model: "claude-a", provider: "anthropic" },
            { key: "openai-b", model: "gpt-b", provider: "openai" },
            { key: "local-a", model: "local-a" },
          ],
          onSelect: async () => success("selected"),
          title: "Models",
        }}
      />,
    );

    const frame = app.lastFrame() ?? "";
    expect(frame.indexOf("OPENAI")).toBeLessThan(frame.indexOf("ANTHROPIC"));
    expect(frame.indexOf("openai-b")).toBeLessThan(frame.indexOf("ANTHROPIC"));
    expect(frame.indexOf("ANTHROPIC")).toBeLessThan(frame.indexOf("OTHER"));
    app.unmount();
  });

  it("accepts pasted model search text", async () => {
    const app = render(
      <ModelPicker
        onCancel={vi.fn()}
        onResult={vi.fn()}
        overlay={{
          kind: "model-picker",
          models: [
            { key: "code", model: "gpt-code", provider: "openai" },
            { key: "reasoning", model: "claude-reasoning", provider: "anthropic" },
          ],
          onSelect: async () => success("selected"),
          title: "Models",
        }}
      />,
    );

    app.stdin.write("\u001B[200~claude\u001B[201~");
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("Search: claude");
      expect(app.lastFrame()).toContain("reasoning");
      expect(app.lastFrame()).not.toContain("gpt-code");
    });
    app.unmount();
  });
});

describe("McpManager", () => {
  it("expands tools, refreshes in place after reconnect, and handles empty state", async () => {
    const onCancel = vi.fn();
    const onResult = vi.fn();
    const onReconnect = vi.fn(async (server: string) => {
      const broken = {
        name: "broken",
        status: "connected" as const,
        toolCount: 1,
        tools: ["search"],
      };
      return server === "ready"
        ? [broken]
        : [
            broken,
            {
              name: "ready",
              status: "connected" as const,
              toolCount: 2,
              tools: ["read", "write"],
            },
          ];
    });
    const overlay: McpManagerOverlay = {
      kind: "mcp-manager",
      onReconnect,
      servers: [
        {
          name: "broken",
          status: "failed",
          toolCount: 0,
          tools: [],
          error: new Error("offline"),
        },
        {
          name: "ready",
          status: "connected",
          toolCount: 2,
          tools: ["read", "write"],
        },
      ],
      title: "MCP",
    };
    const app = render(<McpManager onCancel={onCancel} overlay={overlay} />);

    expect(app.lastFrame()).toContain("offline");
    app.stdin.write(" ");
    app.stdin.write("\r");
    await vi.waitFor(() => {
      expect(onReconnect).toHaveBeenCalledWith("broken");
      expect(selectedLine(app.lastFrame(), "broken · connected")).toContain("›");
      expect(app.lastFrame()).toContain("· search");
      expect(app.lastFrame()).toContain("Reconnected broken.");
      expect(app.lastFrame()).not.toContain("offline");
    });
    expect(onResult).not.toHaveBeenCalled();
    app.stdin.write("\u001B[B");
    await vi.waitFor(() => expect(selectedLine(app.lastFrame(), "ready ·")).toContain("›"));
    app.stdin.write(" ");
    await vi.waitFor(() => expect(app.lastFrame()).toContain("· write"));
    app.stdin.write(" ");
    await vi.waitFor(() => expect(app.lastFrame()).not.toContain("· write"));
    app.stdin.write(" ");
    await vi.waitFor(() => expect(app.lastFrame()).toContain("· write"));
    app.stdin.write("\r");
    await vi.waitFor(() => {
      expect(onReconnect).toHaveBeenCalledWith("ready");
      expect(selectedLine(app.lastFrame(), "broken · connected")).toContain("›");
    });
    app.stdin.write("\u001B");
    await vi.waitFor(() => expect(onCancel).toHaveBeenCalled());
    app.unmount();

    const brokenServer = overlay.servers[0];
    if (brokenServer === undefined) {
      throw new Error("Expected an MCP fixture.");
    }
    const errorApp = render(
      <McpManager
        onCancel={onCancel}
        overlay={{
          ...overlay,
          onReconnect: async () => {
            throw "reconnect failed";
          },
          servers: [brokenServer],
        }}
      />,
    );
    errorApp.stdin.write("\r");
    await vi.waitFor(() => expect(errorApp.lastFrame()).toContain("reconnect failed"));
    expect(onResult).not.toHaveBeenCalled();
    expect(errorApp.lastFrame()).toContain("broken · failed");
    errorApp.unmount();

    const errorObjectApp = render(
      <McpManager
        onCancel={onCancel}
        overlay={{
          ...overlay,
          onReconnect: async () => {
            throw new Error("object reconnect failed");
          },
          servers: [brokenServer],
        }}
      />,
    );
    errorObjectApp.stdin.write("\r");
    await vi.waitFor(() => expect(errorObjectApp.lastFrame()).toContain("object reconnect failed"));
    errorObjectApp.unmount();
    const emptyApp = render(
      <McpManager onCancel={onCancel} overlay={{ ...overlay, servers: [] }} />,
    );
    expect(emptyApp.lastFrame()).toContain("No MCP servers configured");
    emptyApp.unmount();
  });
});

describe("OutputStylePicker and CommandOverlayView", () => {
  it("selects styles, reports errors, cancels, and dispatches overlays", async () => {
    const onCancel = vi.fn();
    const onResult = vi.fn();
    const onSelect = vi.fn(async (style: SessionState["outputStyle"]) => success(style));
    const overlay: OutputStylePickerOverlay = {
      currentStyle: "default",
      kind: "output-style-picker",
      onSelect,
      title: "Style",
    };
    const app = render(
      <OutputStylePicker onCancel={onCancel} onResult={onResult} overlay={overlay} />,
    );

    app.stdin.write("\u001B[B");
    await vi.waitFor(() => expect(selectedLine(app.lastFrame(), "compact")).toContain("›"));
    app.stdin.write("\u001B[A");
    await vi.waitFor(() => expect(selectedLine(app.lastFrame(), "default")).toContain("›"));
    app.stdin.write("\r");
    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith("default"));
    app.stdin.write("\u001B");
    await vi.waitFor(() => expect(onCancel).toHaveBeenCalled());
    app.unmount();

    const errorApp = render(
      <OutputStylePicker
        onCancel={onCancel}
        onResult={onResult}
        overlay={{
          ...overlay,
          onSelect: async () => {
            throw new Error("style failed");
          },
        }}
      />,
    );
    errorApp.stdin.write("\r");
    await vi.waitFor(() =>
      expect(onResult).toHaveBeenCalledWith({
        kind: "error",
        message: "style failed",
        title: "Command Error",
      }),
    );
    errorApp.unmount();

    const dispatchApp = render(
      <CommandOverlayView onCancel={onCancel} onResult={onResult} overlay={overlay} />,
    );
    expect(dispatchApp.lastFrame()).toContain("Style");
    dispatchApp.rerender(
      <CommandOverlayView
        onCancel={onCancel}
        onResult={onResult}
        overlay={sessionOverlay({ sessions: sessionStates(1) })}
      />,
    );
    expect(dispatchApp.lastFrame()).toContain("Sessions");
    dispatchApp.rerender(
      <CommandOverlayView
        onCancel={onCancel}
        onResult={onResult}
        overlay={{
          checkpoints: [],
          kind: "checkpoint-picker",
          onSelect: async () => success("rewound"),
          title: "Checkpoints",
        }}
      />,
    );
    expect(dispatchApp.lastFrame()).toContain("Checkpoints");
    dispatchApp.rerender(
      <CommandOverlayView
        onCancel={onCancel}
        onResult={onResult}
        overlay={{
          currentModel: "code",
          kind: "model-picker",
          models: [],
          onSelect: async () => success("model"),
          title: "Models",
        }}
      />,
    );
    expect(dispatchApp.lastFrame()).toContain("Models");
    dispatchApp.rerender(
      <CommandOverlayView
        onCancel={onCancel}
        onResult={onResult}
        overlay={{
          kind: "mcp-manager",
          onReconnect: async () => [],
          servers: [],
          title: "MCP",
        }}
      />,
    );
    expect(dispatchApp.lastFrame()).toContain("MCP");
    dispatchApp.unmount();
  });
});

describe("overlay defensive states", () => {
  it("guards empty and busy Session picker actions", async () => {
    const onResult = vi.fn();
    const emptyApp = render(
      <SessionPicker
        onCancel={vi.fn()}
        onResult={onResult}
        overlay={sessionOverlay({ sessions: [] })}
      />,
    );
    for (const input of ["\r", "d", "\u0012", "\u001B[A", "\u001B[B", "\u007F", "\u001B[3~"]) {
      emptyApp.stdin.write(input);
    }
    expect(emptyApp.lastFrame()).toContain("No Sessions found.");
    emptyApp.unmount();

    const renameApp = render(
      <SessionPicker
        onCancel={vi.fn()}
        onResult={onResult}
        overlay={sessionOverlay({ sessions: [cliSession("untitled")] })}
      />,
    );
    renameApp.stdin.write("\u0012");
    await vi.waitFor(() => expect(renameApp.lastFrame()).toContain("Rename:  "));
    renameApp.stdin.write("\r");
    expect(onResult).not.toHaveBeenCalled();
    renameApp.stdin.write("\u001B[200~Pasted\u001B[201~");
    await vi.waitFor(() => expect(renameApp.lastFrame()).toContain("Rename: Pasted"));
    renameApp.stdin.write("\u001B");
    await vi.waitFor(() => expect(renameApp.lastFrame()).toContain("Search: all Sessions"));
    renameApp.stdin.write("d");
    await vi.waitFor(() => expect(renameApp.lastFrame()).toContain("[y/N]"));
    renameApp.stdin.write("\u001B");
    await vi.waitFor(() => expect(renameApp.lastFrame()).not.toContain("[y/N]"));
    renameApp.unmount();

    const deferred = deferredResult();
    const onSelect = vi.fn(() => deferred.promise);
    const busyApp = render(
      <SessionPicker
        onCancel={vi.fn()}
        onResult={onResult}
        overlay={sessionOverlay({ onSelect, sessions: [cliSession("busy")] })}
      />,
    );
    busyApp.stdin.write("\r");
    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledOnce());
    busyApp.stdin.write("\r");
    busyApp.stdin.write("\u001B[200~ignored\u001B[201~");
    expect(onSelect).toHaveBeenCalledOnce();
    deferred.resolve(success("done"));
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith(success("done")));
    busyApp.unmount();
  });

  it("guards empty and busy checkpoint, model, MCP, and style actions", async () => {
    const onResult = vi.fn();
    const emptyCheckpoint = render(
      <CheckpointPicker
        onCancel={vi.fn()}
        onResult={onResult}
        overlay={{
          checkpoints: [],
          kind: "checkpoint-picker",
          onSelect: async () => success("unused"),
          title: "Empty",
        }}
      />,
    );
    for (const input of ["x", "\r", "\u001B[A", "\u001B[B"]) {
      emptyCheckpoint.stdin.write(input);
    }
    expect(emptyCheckpoint.lastFrame()).toContain("No checkpoints available.");
    emptyCheckpoint.unmount();

    const unusualCheckpoint = render(
      <CheckpointPicker
        onCancel={vi.fn()}
        onResult={onResult}
        overlay={{
          checkpoints: [
            {
              createdAt: "invalid",
              historyEntries: [],
              id: "small",
              prompt: "",
              sessionRevision: 1,
              totalBytes: 100,
            },
            {
              createdAt: "2026-08-10T00:00:00.000Z",
              historyEntries: [],
              id: "unknown",
              prompt: "unknown",
              sessionRevision: 2,
            },
          ],
          kind: "checkpoint-picker",
          onSelect: async () => success("selected"),
          title: "Unusual",
        }}
      />,
    );
    expect(unusualCheckpoint.lastFrame()).toContain("(empty prompt)");
    expect(unusualCheckpoint.lastFrame()).toContain("100 B");
    expect(unusualCheckpoint.lastFrame()).toContain("size unknown");
    unusualCheckpoint.unmount();

    const emptyModel = render(
      <ModelPicker
        onCancel={vi.fn()}
        onResult={onResult}
        overlay={{
          kind: "model-picker",
          models: [],
          onSelect: async () => success("unused"),
          title: "Empty Models",
        }}
      />,
    );
    for (const input of ["\r", "\u001B[A", "\u001B[B", "\u007F", "\u001B[3~", "g"]) {
      emptyModel.stdin.write(input);
    }
    expect(emptyModel.lastFrame()).toContain("No models found.");
    emptyModel.unmount();

    const modelDeferred = deferredResult();
    const modelSelect = vi.fn(() => modelDeferred.promise);
    const busyModel = render(
      <ModelPicker
        onCancel={vi.fn()}
        onResult={onResult}
        overlay={{
          kind: "model-picker",
          models: [{ key: "model", model: "model" }],
          onSelect: modelSelect,
          title: "Busy Model",
        }}
      />,
    );
    busyModel.stdin.write("\r");
    await vi.waitFor(() => expect(modelSelect).toHaveBeenCalledOnce());
    busyModel.stdin.write("\r");
    busyModel.stdin.write("\u001B[200~ignored\u001B[201~");
    expect(modelSelect).toHaveBeenCalledOnce();
    modelDeferred.resolve(success("model done"));
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith(success("model done")));
    busyModel.unmount();

    const emptyMcp = render(
      <McpManager
        onCancel={vi.fn()}
        overlay={{
          kind: "mcp-manager",
          onReconnect: async () => [],
          servers: [],
          title: "Empty MCP",
        }}
      />,
    );
    for (const input of [" ", "\r", "\u001B[A", "\u001B[B"]) {
      emptyMcp.stdin.write(input);
    }
    expect(emptyMcp.lastFrame()).toContain("No MCP servers configured");
    emptyMcp.unmount();

    const statusMcp = render(
      <McpManager
        onCancel={vi.fn()}
        overlay={{
          kind: "mcp-manager",
          onReconnect: async () => [],
          servers: [
            { name: "connecting", status: "connecting", toolCount: 0, tools: [] },
            { name: "pending", status: "pending", toolCount: 0, tools: [] },
            { name: "disconnected", status: "disconnected", toolCount: 0, tools: [] },
          ],
          title: "Statuses",
        }}
      />,
    );
    statusMcp.stdin.write(" ");
    await vi.waitFor(() => expect(statusMcp.lastFrame()).toContain("connecting"));
    statusMcp.stdin.write(" ");
    statusMcp.unmount();

    const styleDeferred = deferredResult();
    const styleSelect = vi.fn(() => styleDeferred.promise);
    const busyStyle = render(
      <OutputStylePicker
        onCancel={vi.fn()}
        onResult={onResult}
        overlay={{
          currentStyle: "compact",
          kind: "output-style-picker",
          onSelect: styleSelect,
          title: "Busy Style",
        }}
      />,
    );
    busyStyle.stdin.write("x");
    busyStyle.stdin.write("\u001B[A");
    busyStyle.stdin.write("\r");
    await vi.waitFor(() => expect(styleSelect).toHaveBeenCalledOnce());
    busyStyle.stdin.write("\r");
    expect(styleSelect).toHaveBeenCalledOnce();
    styleDeferred.resolve(success("style done"));
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith(success("style done")));
    busyStyle.unmount();
  });
});

function sessionOverlay(overrides: Partial<SessionPickerOverlay> = {}): SessionPickerOverlay {
  return {
    currentSessionId: "session-1",
    kind: "session-picker",
    onDelete: async (id) => success(`deleted ${id}`),
    onRename: async (id, title) => success(`renamed ${id}:${title}`),
    onSelect: async (id) => success(`selected ${id}`),
    sessions: sessionStates(2),
    title: "Sessions",
    ...overrides,
  };
}

function cliSession(sessionId: string): SessionState {
  return createInitialSessionState({
    agentKey: "code",
    configFingerprint: "config",
    modelKey: "model",
    now: "2026-08-10T00:00:00.000Z",
    sessionId,
    workspaceDir: "/workspace",
  });
}

function sessionStates(count: number): readonly SessionState[] {
  return Array.from({ length: count }, (_, index) => ({
    ...createInitialSessionState({
      agentKey: "code",
      configFingerprint: "config",
      modelKey: "model",
      now: "2026-08-10T00:00:00.000Z",
      sessionId: `session-${index + 1}`,
      workspaceDir: "/workspace",
    }),
    ...(index === 0 ? { title: "Session 1" } : {}),
  }));
}

function checkpoint(id: string, index: number) {
  return {
    createdAt: "2026-08-10T00:00:00.000Z",
    fileCount: index + 1,
    historyEntries: [],
    id,
    prompt: `prompt ${index + 1}`,
    sessionRevision: index + 1,
    totalBytes: (index + 1) * 1_024,
  };
}

function selectedLine(frame: string | undefined, text: string): string {
  return frame?.split("\n").find((line) => line.includes(text)) ?? "";
}

function success(message: string): SlashCommandResult {
  return { kind: "success", message };
}

function deferredResult(): {
  readonly promise: Promise<SlashCommandResult>;
  readonly resolve: (result: SlashCommandResult) => void;
} {
  let resolvePromise: ((result: SlashCommandResult) => void) | undefined;
  const promise = new Promise<SlashCommandResult>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (result) => resolvePromise?.(result),
  };
}
