import { Box, Text } from "ink";
import type { QueuedPrompt } from "./types.js";

export function QueuedPromptList({
  queuedPrompts,
}: {
  readonly queuedPrompts: readonly QueuedPrompt[];
}) {
  return (
    <Box flexDirection="column" marginLeft={1}>
      {queuedPrompts.map((queuedPrompt) => (
        <Box key={queuedPrompt.id}>
          <Text color="gray">› {queuedPrompt.text}</Text>
        </Box>
      ))}
      <Text color="gray">↑ Press up to edit queued messages</Text>
    </Box>
  );
}
