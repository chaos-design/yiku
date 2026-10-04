import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { OutputStylePickerOverlay, SlashCommandResult } from "../slash-commands/types.js";

const STYLES = ["default", "compact", "verbose"] as const;

export function OutputStylePicker({
  onCancel,
  onResult,
  overlay,
}: {
  readonly onCancel: () => void;
  readonly onResult: (result: SlashCommandResult) => void;
  readonly overlay: OutputStylePickerOverlay;
}) {
  const initialIndex = Math.max(0, STYLES.indexOf(overlay.currentStyle));
  const [busy, setBusy] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(initialIndex);

  useInput((_input, key) => {
    if (busy) {
      return;
    }
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow) {
      setSelectedIndex(Math.max(0, selectedIndex - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex(Math.min(STYLES.length - 1, selectedIndex + 1));
      return;
    }
    if (!key.return) {
      return;
    }
    const style = STYLES[selectedIndex];
    if (style === undefined) {
      return;
    }
    setBusy(true);
    void overlay
      .onSelect(style)
      .then(onResult)
      .catch((error: unknown) =>
        onResult({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
          title: "Command Error",
        }),
      )
      .finally(() => setBusy(false));
  });

  return (
    <Box borderColor="magenta" borderStyle="round" flexDirection="column" paddingX={1}>
      <Text bold color="magenta">
        {overlay.title}
      </Text>
      {STYLES.map((style, index) => (
        <Text color={index === selectedIndex ? "yellow" : "gray"} key={style}>
          {index === selectedIndex ? "› " : "  "}
          {style}
          {style === overlay.currentStyle ? " · current" : ""}
        </Text>
      ))}
      <Text color="gray">↑↓ select · Enter apply · Esc cancel</Text>
    </Box>
  );
}
