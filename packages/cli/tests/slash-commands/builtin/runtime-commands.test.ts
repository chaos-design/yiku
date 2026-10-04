import { describe, expect, it, vi } from "vitest";
import { mcpCommand } from "../../../src/slash-commands/builtin/mcp.js";
import { modelCommand } from "../../../src/slash-commands/builtin/model.js";
import { outputStyleCommand } from "../../../src/slash-commands/builtin/output-style.js";
import type {
  InteractiveSlashCommand,
  SlashCommandArguments,
  SlashCommandContext,
  SlashCommandRuntime,
} from "../../../src/slash-commands/types.js";

describe("/model", () => {
  it("sets a Session or global model directly", async () => {
    const runtime = runtimeService();
    const context = { runtime } as unknown as SlashCommandContext;

    await expect(open(modelCommand, context, ["code"])).resolves.toEqual({
      kind: "success",
      message: "Model set to code for this Session.",
      title: "Model",
    });
    await expect(open(modelCommand, context, ["reasoning", "--global"])).resolves.toEqual({
      kind: "success",
      message: "Model set to reasoning and as the global default.",
      title: "Model",
    });
    expect(runtime.setModel).toHaveBeenNthCalledWith(1, "code", { global: false });
    expect(runtime.setModel).toHaveBeenNthCalledWith(2, "reasoning", { global: true });
  });

  it("opens a model picker and applies its selection", async () => {
    const runtime = runtimeService();
    const context = { runtime } as unknown as SlashCommandContext;
    const overlay = await open(modelCommand, context);

    expect(overlay).toMatchObject({
      currentModel: "code",
      kind: "model-picker",
      models: [
        { key: "code", model: "gpt-5.3", provider: "openai" },
        { key: "reasoning", model: "claude-opus-4.6", provider: "anthropic" },
      ],
      title: "Select Model",
    });
    if (overlay.kind !== "model-picker") {
      throw new Error("Expected a model picker overlay.");
    }

    await expect(overlay.onSelect("reasoning", { global: true })).resolves.toEqual({
      kind: "success",
      message: "Model set to reasoning and as the global default.",
      title: "Model",
    });
    expect(runtime.setModel).toHaveBeenLastCalledWith("reasoning", { global: true });
  });

  it("rejects missing model keys, misplaced flags, and extra arguments", async () => {
    const runtime = runtimeService();
    const context = { runtime } as unknown as SlashCommandContext;

    for (const values of [
      ["--global"],
      ["--global", "code"],
      ["code", "extra"],
      ["code", "--global", "extra"],
      ["code", "--global", "--global"],
    ]) {
      await expect(open(modelCommand, context, values)).resolves.toEqual({
        kind: "error",
        message: "Usage: /model [key] [--global]",
        title: "Command Error",
      });
    }
    expect(runtime.setModel).not.toHaveBeenCalled();
  });
});

describe("/mcp", () => {
  it("opens the MCP manager and reconnects a server", async () => {
    const runtime = runtimeService();
    const context = { runtime } as unknown as SlashCommandContext;
    const overlay = await open(mcpCommand, context);

    expect(overlay).toMatchObject({
      kind: "mcp-manager",
      servers: [
        {
          name: "github",
          status: "failed",
          toolCount: 0,
          tools: [],
        },
      ],
      title: "MCP Servers",
    });
    if (overlay.kind !== "mcp-manager") {
      throw new Error("Expected an MCP manager overlay.");
    }

    await expect(overlay.onReconnect("github")).resolves.toEqual([
      {
        error: new Error("offline"),
        name: "github",
        status: "failed",
        toolCount: 0,
        tools: [],
      },
    ]);
    expect(runtime.reconnectMcp).toHaveBeenCalledWith("github");
    expect(runtime.mcpStatus).toHaveBeenCalledTimes(2);
  });

  it("rejects all arguments", async () => {
    const runtime = runtimeService();

    await expect(
      open(mcpCommand, { runtime } as unknown as SlashCommandContext, ["github"]),
    ).resolves.toEqual({
      kind: "error",
      message: "Usage: /mcp",
      title: "Command Error",
    });
    expect(runtime.mcpStatus).not.toHaveBeenCalled();
  });
});

describe("/output-style", () => {
  it("sets every supported output style directly", async () => {
    const runtime = runtimeService();
    const context = { runtime } as unknown as SlashCommandContext;

    for (const style of ["compact", "default", "verbose"] as const) {
      await expect(open(outputStyleCommand, context, [style])).resolves.toEqual({
        kind: "success",
        message: `Output style set to ${style}.`,
        title: "Output Style",
      });
    }
    expect(runtime.setOutputStyle).toHaveBeenNthCalledWith(1, "compact");
    expect(runtime.setOutputStyle).toHaveBeenNthCalledWith(2, "default");
    expect(runtime.setOutputStyle).toHaveBeenNthCalledWith(3, "verbose");
  });

  it("opens an output style picker and applies its selection", async () => {
    const runtime = runtimeService();
    const context = { runtime } as unknown as SlashCommandContext;
    const overlay = await open(outputStyleCommand, context);

    expect(overlay).toMatchObject({
      currentStyle: "default",
      kind: "output-style-picker",
      title: "Select Output Style",
    });
    if (overlay.kind !== "output-style-picker") {
      throw new Error("Expected an output style picker overlay.");
    }

    await expect(overlay.onSelect("compact")).resolves.toEqual({
      kind: "success",
      message: "Output style set to compact.",
      title: "Output Style",
    });
    expect(runtime.setOutputStyle).toHaveBeenCalledWith("compact");
  });

  it("rejects unknown styles and extra arguments", async () => {
    const runtime = runtimeService();
    const context = { runtime } as unknown as SlashCommandContext;

    for (const values of [["brief"], ["compact", "extra"]]) {
      await expect(open(outputStyleCommand, context, values)).resolves.toEqual({
        kind: "error",
        message: "Usage: /output-style [compact|default|verbose]",
        title: "Command Error",
      });
    }
    expect(runtime.setOutputStyle).not.toHaveBeenCalled();
  });
});

function open(
  command: InteractiveSlashCommand,
  context: SlashCommandContext,
  values: readonly string[] = [],
) {
  const arguments_: SlashCommandArguments = {
    raw: values.join(" "),
    values,
  };
  return command.open(context, arguments_);
}

function runtimeService() {
  return {
    currentModel: vi.fn(async () => "code"),
    mcpStatus: vi.fn(async () => [
      {
        error: new Error("offline"),
        name: "github",
        status: "failed" as const,
        toolCount: 0,
        tools: [],
      },
    ]),
    models: vi.fn(async () => [
      { key: "code", model: "gpt-5.3", provider: "openai" },
      { key: "reasoning", model: "claude-opus-4.6", provider: "anthropic" },
    ]),
    outputStyle: vi.fn(async () => "default" as const),
    reconnectMcp: vi.fn(async (_server: string) => undefined),
    setModel: vi.fn(async (_modelKey: string, _options: { readonly global: boolean }) => undefined),
    setOutputStyle: vi.fn(async (_style: "compact" | "default" | "verbose") => undefined),
  } satisfies SlashCommandRuntime;
}
