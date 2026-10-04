import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { CheckpointPickerOverlay, SlashCommandResult } from "../slash-commands/types.js";

const PAGE_SIZE = 10;

export function CheckpointPicker({
  onCancel,
  onResult,
  overlay,
}: {
  readonly onCancel: () => void;
  readonly onResult: (result: SlashCommandResult) => void;
  readonly overlay: CheckpointPickerOverlay;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | undefined>();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const checkpoints = overlay.checkpoints;
  const resolvedSelectedIndex = Math.min(selectedIndex, Math.max(0, checkpoints.length - 1));
  const pageStart = Math.floor(resolvedSelectedIndex / PAGE_SIZE) * PAGE_SIZE;
  const visibleCheckpoints = checkpoints.slice(pageStart, pageStart + PAGE_SIZE);

  useInput((_input, key) => {
    if (busy) {
      return;
    }
    if (key.escape) {
      if (confirmingId !== undefined) {
        setConfirmingId(undefined);
        return;
      }
      onCancel();
      return;
    }
    if (key.upArrow) {
      setConfirmingId(undefined);
      setSelectedIndex(Math.max(0, resolvedSelectedIndex - 1));
      return;
    }
    if (key.downArrow) {
      setConfirmingId(undefined);
      setSelectedIndex(Math.min(Math.max(0, checkpoints.length - 1), resolvedSelectedIndex + 1));
      return;
    }
    if (!key.return) {
      return;
    }
    const checkpoint = checkpoints[resolvedSelectedIndex];
    if (checkpoint === undefined) {
      return;
    }
    if (confirmingId !== checkpoint.id) {
      setConfirmingId(checkpoint.id);
      return;
    }
    setBusy(true);
    void overlay
      .onSelect(checkpoint.id)
      .then(onResult)
      .catch((error: unknown) =>
        onResult({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
          title: "Command Error",
        }),
      )
      .finally(() => {
        setBusy(false);
        setConfirmingId(undefined);
      });
  });

  return (
    <Box borderColor="magenta" borderStyle="round" flexDirection="column" paddingX={1}>
      <Text bold color="magenta">
        {overlay.title}
      </Text>
      {visibleCheckpoints.length === 0 ? (
        <Text color="gray">No checkpoints available.</Text>
      ) : (
        visibleCheckpoints.map((checkpoint, index) => {
          const absoluteIndex = pageStart + index;
          return (
            <Box flexDirection="column" key={checkpoint.id}>
              <Text color={absoluteIndex === resolvedSelectedIndex ? "yellow" : "gray"}>
                {absoluteIndex === resolvedSelectedIndex ? "› " : "  "}
                {checkpoint.prompt || "(empty prompt)"}
              </Text>
              <Text color="gray">
                {"    "}
                {checkpoint.id} · {formatTime(checkpoint.createdAt)} · r{checkpoint.sessionRevision}{" "}
                · {checkpoint.fileCount ?? "?"} files · {formatBytes(checkpoint.totalBytes)} ·{" "}
                {checkpoint.historyEntries.length} history entries
              </Text>
            </Box>
          );
        })
      )}
      {confirmingId !== undefined ? (
        <Text color="yellow">Rewind replaces files and history. Press Enter again to confirm.</Text>
      ) : null}
      <Text color="gray">
        {confirmingId === undefined
          ? "↑↓ select · Enter review · Esc cancel"
          : "Enter confirm · Esc back"}
        {checkpoints.length > PAGE_SIZE
          ? ` · ${pageStart + 1}-${Math.min(pageStart + PAGE_SIZE, checkpoints.length)}/${checkpoints.length}`
          : ""}
      </Text>
    </Box>
  );
}

function formatTime(value: string): string {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString();
}

function formatBytes(value: number | undefined): string {
  if (value === undefined) {
    return "size unknown";
  }
  if (value < 1_024) {
    return `${value} B`;
  }
  return `${(value / 1_024).toFixed(value < 10_240 ? 1 : 0)} KiB`;
}
