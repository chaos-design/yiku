import type { InteractiveSlashCommand, SlashCommandResult } from "../types.js";

const USAGE = "Usage: /model [key] [--global]";

export const modelCommand: InteractiveSlashCommand = {
  description: "Select or set the Session model",
  execution: "idle",
  kind: "interactive",
  name: "model",
  open: async (context, arguments_) => {
    if (arguments_.values.length === 0) {
      const [models, currentModel] = await Promise.all([
        context.runtime.models(),
        context.runtime.currentModel(),
      ]);
      return {
        ...(currentModel === undefined ? {} : { currentModel }),
        kind: "model-picker",
        models,
        onSelect: async (modelKey, options) => {
          await context.runtime.setModel(modelKey, options);
          return modelResult(modelKey, options.global);
        },
        title: "Select Model",
      };
    }

    const [modelKey, flag] = arguments_.values;
    if (
      modelKey === undefined ||
      modelKey === "--global" ||
      arguments_.values.length > 2 ||
      (flag !== undefined && flag !== "--global")
    ) {
      return commandResult(usage());
    }

    const global = flag === "--global";
    await context.runtime.setModel(modelKey, { global });
    return commandResult(modelResult(modelKey, global));
  },
  source: "builtin",
};

function modelResult(modelKey: string, global: boolean): SlashCommandResult {
  return {
    kind: "success",
    message: global
      ? `Model set to ${modelKey} and as the global default.`
      : `Model set to ${modelKey} for this Session.`,
    title: "Model",
  };
}

function usage(): SlashCommandResult {
  return {
    kind: "error",
    message: USAGE,
    title: "Command Error",
  };
}

function commandResult(result: SlashCommandResult): SlashCommandResult {
  return result;
}
