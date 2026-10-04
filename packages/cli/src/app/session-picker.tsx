import { Box, Text, useInput, usePaste } from "ink";
import { useMemo, useState } from "react";
import type { SessionPickerOverlay, SlashCommandResult } from "../slash-commands/types.js";

const PAGE_SIZE = 10;

export function SessionPicker({
  onCancel,
  onResult,
  overlay,
}: {
  readonly onCancel: () => void;
  readonly onResult: (result: SlashCommandResult) => void;
  readonly overlay: SessionPickerOverlay;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [query, setQuery] = useState("");
  const [renameDraft, setRenameDraft] = useState<string | undefined>();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const sessions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return overlay.sessions;
    }
    return overlay.sessions.filter(
      (session) =>
        session.sessionId.toLowerCase().includes(normalizedQuery) ||
        session.title?.toLowerCase().includes(normalizedQuery),
    );
  }, [overlay.sessions, query]);
  const resolvedSelectedIndex = Math.min(selectedIndex, Math.max(0, sessions.length - 1));
  const pageStart = Math.floor(resolvedSelectedIndex / PAGE_SIZE) * PAGE_SIZE;
  const visibleSessions = sessions.slice(pageStart, pageStart + PAGE_SIZE);
  const selectedSession = sessions[resolvedSelectedIndex];

  const run = (operation: () => Promise<SlashCommandResult>) => {
    if (busy) {
      return;
    }
    setBusy(true);
    void operation()
      .then(onResult)
      .catch((error: unknown) =>
        onResult({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
          title: "Command Error",
        }),
      )
      .finally(() => setBusy(false));
  };

  usePaste((text) => {
    if (busy || confirmDelete) {
      return;
    }
    if (renameDraft !== undefined) {
      setRenameDraft(renameDraft + text);
      return;
    }
    setQuery(query + text);
    setSelectedIndex(0);
  });

  useInput((input, key) => {
    if (busy) {
      return;
    }

    if (confirmDelete) {
      if (key.escape || input.toLowerCase() === "n") {
        setConfirmDelete(false);
        return;
      }
      if (input.toLowerCase() === "y" && selectedSession !== undefined) {
        run(() => overlay.onDelete(selectedSession.sessionId));
      }
      return;
    }

    if (renameDraft !== undefined) {
      if (key.escape) {
        setRenameDraft(undefined);
        return;
      }
      if (key.return && selectedSession !== undefined && renameDraft.trim()) {
        run(() => overlay.onRename(selectedSession.sessionId, renameDraft.trim()));
        return;
      }
      if (key.backspace || key.delete) {
        setRenameDraft((current) => current?.slice(0, -1) ?? "");
        return;
      }
      if (!key.ctrl && !key.meta && input) {
        setRenameDraft((current) => `${current ?? ""}${input}`);
      }
      return;
    }

    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow) {
      setSelectedIndex(Math.max(0, resolvedSelectedIndex - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex(Math.min(Math.max(0, sessions.length - 1), resolvedSelectedIndex + 1));
      return;
    }
    if (key.return && selectedSession !== undefined) {
      run(() => overlay.onSelect(selectedSession.sessionId));
      return;
    }
    if (key.ctrl && input.toLowerCase() === "r" && selectedSession !== undefined) {
      setRenameDraft(selectedSession.title ?? "");
      return;
    }
    if (input.toLowerCase() === "d" && selectedSession !== undefined) {
      setConfirmDelete(true);
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((current) => current.slice(0, -1));
      setSelectedIndex(0);
      return;
    }
    if (!key.ctrl && !key.meta && input) {
      setQuery((current) => current + input);
      setSelectedIndex(0);
    }
  });

  return (
    <Box borderColor="magenta" borderStyle="round" flexDirection="column" paddingX={1}>
      <Text bold color="magenta">
        {overlay.title}
      </Text>
      <Text color="gray">
        {renameDraft !== undefined
          ? `Rename: ${renameDraft || " "}`
          : confirmDelete
            ? `Delete ${selectedSession?.sessionId ?? "Session"}? [y/N]`
            : `Search: ${query || "all Sessions"}`}
      </Text>
      {visibleSessions.length === 0 ? (
        <Text color="gray">No Sessions found.</Text>
      ) : (
        visibleSessions.map((session, index) => {
          const absoluteIndex = pageStart + index;
          const selected = absoluteIndex === resolvedSelectedIndex;
          const current = session.sessionId === overlay.currentSessionId;
          return (
            <Text color={selected ? "yellow" : "gray"} key={session.sessionId}>
              {selected ? "› " : "  "}
              {session.title ?? session.sessionId}
              {session.title === undefined ? "" : ` · ${session.sessionId}`}
              {current ? " · current" : ""}
              {` · ${session.status}`}
            </Text>
          );
        })
      )}
      <Text color="gray">
        ↑↓ select · Enter resume · Ctrl+R rename · d delete · Esc cancel
        {sessions.length > PAGE_SIZE
          ? ` · ${pageStart + 1}-${Math.min(pageStart + PAGE_SIZE, sessions.length)}/${sessions.length}`
          : ""}
      </Text>
    </Box>
  );
}
