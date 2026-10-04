import type { CommandOverlay, SlashCommandResult } from "../slash-commands/types.js";
import { CheckpointPicker } from "./checkpoint-picker.js";
import { McpManager } from "./mcp-manager.js";
import { ModelPicker } from "./model-picker.js";
import { OutputStylePicker } from "./output-style-picker.js";
import { SessionPicker } from "./session-picker.js";

export function CommandOverlayView({
  onCancel,
  onResult,
  overlay,
}: {
  readonly onCancel: () => void;
  readonly onResult: (result: SlashCommandResult) => void;
  readonly overlay: CommandOverlay;
}) {
  switch (overlay.kind) {
    case "session-picker":
      return <SessionPicker onCancel={onCancel} onResult={onResult} overlay={overlay} />;
    case "checkpoint-picker":
      return <CheckpointPicker onCancel={onCancel} onResult={onResult} overlay={overlay} />;
    case "model-picker":
      return <ModelPicker onCancel={onCancel} onResult={onResult} overlay={overlay} />;
    case "mcp-manager":
      return <McpManager onCancel={onCancel} overlay={overlay} />;
    case "output-style-picker":
      return <OutputStylePicker onCancel={onCancel} onResult={onResult} overlay={overlay} />;
  }
}
