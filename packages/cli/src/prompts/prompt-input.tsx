import { Box, Text } from "ink";
import { LAYOUT_SPACING } from "../app/constants.js";
import { PROMPT_CURSOR } from "./constants.js";
import { getPromptRows, type PromptRow } from "./prompt-preview.js";

export function PromptInput({
  cursorIndex,
  input,
  isShellInput = false,
  isSlashInput,
  maxVisibleColumns,
  maxVisibleRows,
}: {
  readonly cursorIndex: number;
  readonly input: string;
  readonly isShellInput?: boolean | undefined;
  readonly isSlashInput: boolean;
  readonly maxVisibleColumns?: number;
  readonly maxVisibleRows?: number;
}) {
  const { hasAbove, hasBelow, rows } = getPromptRows(
    input,
    cursorIndex,
    maxVisibleRows,
    maxVisibleColumns,
  );
  const inputColor = isShellInput ? "green" : isSlashInput ? "magenta" : "white";
  const borderColor = isShellInput ? "green" : isSlashInput ? "magenta" : "gray";

  return (
    <Box
      borderColor={borderColor}
      borderStyle="round"
      flexDirection="column"
      marginBottom={LAYOUT_SPACING.prompt}
      paddingX={1}
      width="100%"
    >
      {hasAbove ? <Text color="gray">↑ more</Text> : null}
      {rows.map((row) => (
        <PromptInputRow
          key={row.lineIndex}
          inputColor={inputColor}
          row={row}
          showPrefix={row.lineIndex === 0}
        />
      ))}
      {hasBelow ? <Text color="gray">↓ more</Text> : null}
    </Box>
  );
}

function PromptInputRow({
  inputColor,
  row,
  showPrefix,
}: {
  readonly inputColor: string;
  readonly row: PromptRow;
  readonly showPrefix: boolean;
}) {
  const textColor = row.placeholder ? "gray" : inputColor;
  const isBlockCursor = row.cursor === PROMPT_CURSOR;

  return (
    <Box>
      <Text color={row.placeholder ? "gray" : inputColor}>{showPrefix ? "> " : "  "}</Text>
      <Text color={textColor}>{row.before}</Text>
      {row.cursor ? (
        isBlockCursor ? (
          <Text color={inputColor}>{row.cursor}</Text>
        ) : (
          <Text backgroundColor="white" color="black">
            {row.cursor}
          </Text>
        )
      ) : null}
      <Text color={textColor}>{row.after}</Text>
    </Box>
  );
}
