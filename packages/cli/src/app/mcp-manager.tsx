import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import type { McpManagerOverlay } from "../slash-commands/types.js";

export function McpManager({
  onCancel,
  overlay,
}: {
  readonly onCancel: () => void;
  readonly overlay: McpManagerOverlay;
}) {
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [servers, setServers] = useState(overlay.servers);
  const [statusMessage, setStatusMessage] = useState<
    { readonly text: string; readonly tone: "error" | "success" } | undefined
  >();
  const resolvedSelectedIndex = Math.min(selectedIndex, Math.max(0, servers.length - 1));
  const selectedServer = servers[resolvedSelectedIndex];
  const selectedServerName = selectedServer?.name;
  const visibleExpanded = useMemo(
    () => new Set([...expanded].filter((name) => servers.some((server) => server.name === name))),
    [expanded, servers],
  );

  useInput((input, key) => {
    if (busy) {
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
      setSelectedIndex(Math.min(Math.max(0, servers.length - 1), resolvedSelectedIndex + 1));
      return;
    }
    if (input === " " && selectedServer !== undefined) {
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(selectedServer.name)) {
          next.delete(selectedServer.name);
        } else {
          next.add(selectedServer.name);
        }
        return next;
      });
      return;
    }
    if (key.return && selectedServer !== undefined) {
      setBusy(true);
      setStatusMessage(undefined);
      void overlay
        .onReconnect(selectedServer.name)
        .then((nextServers) => {
          setServers(nextServers);
          const nextIndex = nextServers.findIndex((server) => server.name === selectedServerName);
          setSelectedIndex(nextIndex === -1 ? 0 : nextIndex);
          setStatusMessage({
            text: `Reconnected ${selectedServer.name}.`,
            tone: "success",
          });
        })
        .catch((error: unknown) => {
          setStatusMessage({
            text: error instanceof Error ? error.message : String(error),
            tone: "error",
          });
        })
        .finally(() => setBusy(false));
    }
  });

  return (
    <Box borderColor="magenta" borderStyle="round" flexDirection="column" paddingX={1}>
      <Text bold color="magenta">
        {overlay.title}
      </Text>
      {servers.length === 0 ? (
        <Text color="gray">No MCP servers configured for this Session.</Text>
      ) : (
        servers.map((server, index) => (
          <Box flexDirection="column" key={server.name}>
            <Text color={index === resolvedSelectedIndex ? "yellow" : statusColor(server.status)}>
              {index === resolvedSelectedIndex ? "› " : "  "}
              {server.name} · {server.status} · {server.toolCount} tools
            </Text>
            {server.error !== undefined ? (
              <Text color="red">
                {"    "}
                {server.error.message}
              </Text>
            ) : null}
            {visibleExpanded.has(server.name)
              ? server.tools.map((tool) => (
                  <Text color="gray" key={`${server.name}:${tool}`}>
                    {"    "}· {tool}
                  </Text>
                ))
              : null}
          </Box>
        ))
      )}
      {statusMessage !== undefined ? (
        <Text color={statusMessage.tone === "error" ? "red" : "green"}>{statusMessage.text}</Text>
      ) : null}
      <Text color="gray">↑↓ select · Space tools · Enter reconnect · Esc close</Text>
    </Box>
  );
}

function statusColor(status: McpManagerOverlay["servers"][number]["status"]): string {
  switch (status) {
    case "connected":
      return "green";
    case "connecting":
    case "pending":
      return "yellow";
    case "disconnected":
      return "gray";
    case "failed":
      return "red";
  }
}
