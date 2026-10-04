import type { InteractiveSlashCommand, SlashCommandResult } from "../types.js";

const OUTPUT_STYLES = ["compact", "default", "verbose"] as const;
type OutputStyle = (typeof OUTPUT_STYLES)[number];

export const outputStyleCommand: InteractiveSlashCommand = {
  description: "Select or set the Session output style",
  kind: "interactive",
  name: "output-style",
  open: async (context, arguments_) => {
    if (arguments_.values.length === 0) {
      return {
        currentStyle: await context.runtime.outputStyle(),
        kind: "output-style-picker",
        onSelect: async (style) => {
          await context.runtime.setOutputStyle(style);
          return outputStyleResult(style);
        },
        title: "Select Output Style",
      };
    }

    const [style] = arguments_.values;
    if (arguments_.values.length !== 1 || !isOutputStyle(style)) {
      return commandResult(usage());
    }

    await context.runtime.setOutputStyle(style);
    return commandResult(outputStyleResult(style));
  },
  source: "builtin",
};

function isOutputStyle(value: string | undefined): value is OutputStyle {
  return OUTPUT_STYLES.some((style) => style === value);
}

function outputStyleResult(style: OutputStyle): SlashCommandResult {
  return {
    kind: "success",
    message: `Output style set to ${style}.`,
    title: "Output Style",
  };
}

function usage(): SlashCommandResult {
  return {
    kind: "error",
    message: "Usage: /output-style [compact|default|verbose]",
    title: "Command Error",
  };
}

function commandResult(result: SlashCommandResult): SlashCommandResult {
  return result;
}
