import type { SessionState } from "@yiku/agent-orchestrator";
import { Box, Text } from "ink";
import { LAYOUT_SPACING, TOOL_DETAIL_PREFIX, TOOL_RESULT_PREFIX } from "./constants.js";
import { stripReadLineNumbers } from "./tool-presentation.js";
import type { MessageColor, MessageContent, TimelineToolItem } from "./types.js";

export function ToolBlockView({
  indent = 0,
  item,
  outputStyle = "default",
  prefix = "",
}: {
  readonly indent?: number | undefined;
  readonly item: TimelineToolItem;
  readonly outputStyle?: SessionState["outputStyle"] | undefined;
  readonly prefix?: string | undefined;
}) {
  if (outputStyle === "compact") {
    return (
      <Box marginBottom={LAYOUT_SPACING.item} marginLeft={indent}>
        <Text>
          {prefix ? <Text color="gray">{prefix}</Text> : null}
          <Text color={getToolCallColor(item.toolName)}>● </Text>
          <Text color="white">{item.call.text}</Text>
          {item.result !== undefined ? <Text color="gray"> → {compactResult(item)}</Text> : null}
        </Text>
      </Box>
    );
  }
  const result = outputStyle === "verbose" ? verboseResult(item) : item.result;
  const detailOccurrences = new Map<string, number>();

  return (
    <Box flexDirection="column" marginBottom={LAYOUT_SPACING.item} marginLeft={indent}>
      <ToolCallView item={item} prefix={prefix} />
      {item.call.details?.map((line) => {
        const occurrence = (detailOccurrences.get(line) ?? 0) + 1;
        detailOccurrences.set(line, occurrence);
        return (
          <Box key={`${line}:${occurrence}`} marginLeft={prefix.length + 2}>
            <Text color="gray">
              {TOOL_DETAIL_PREFIX}
              {line}
            </Text>
          </Box>
        );
      })}
      {result ? (
        <ToolResultView result={result} resultIndent={prefix.length + 2} toolName={item.toolName} />
      ) : null}
    </Box>
  );
}

function compactResult(item: TimelineToolItem): string {
  const rawOutput = outputText(item.output);
  if (rawOutput !== undefined) {
    const lines = rawOutput.split(/\r?\n/u).filter((line) => line.length > 0);
    if (lines.length > 1) {
      return `${lines.length} lines`;
    }
    if (lines[0]?.trim()) {
      return lines[0].trim();
    }
  }
  return item.result?.text ?? "finished";
}

function verboseResult(item: TimelineToolItem): MessageContent | undefined {
  const rawText = outputText(item.output);
  if (rawText === undefined || !rawText.trim()) {
    return item.result;
  }
  const text = isReadTool(item) ? stripReadLineNumbers(rawText) : rawText;
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  while (lines.length > 0 && !lines[0]?.trim()) {
    lines.shift();
  }
  while (lines.length > 0 && !lines.at(-1)?.trim()) {
    lines.pop();
  }
  const [firstLine = "(empty output)", ...details] = lines;
  return {
    ...(details.length > 0 ? { details } : {}),
    text: firstLine,
  };
}

function isReadTool(item: TimelineToolItem): boolean {
  if (item.toolName === "readTool") {
    return true;
  }
  if (item.toolName !== "textEditorTool") {
    return false;
  }
  return (
    typeof item.input === "object" &&
    item.input !== null &&
    "command" in item.input &&
    item.input.command === "view"
  );
}

function outputText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value !== "object" || value === null) {
    return value === undefined ? undefined : String(value);
  }
  if ("llmContent" in value && typeof value.llmContent === "string") {
    return value.llmContent;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ToolCallView({
  item,
  prefix,
}: {
  readonly item: TimelineToolItem;
  readonly prefix: string;
}) {
  const argumentStart = item.call.text.indexOf("(");
  const isTodo = item.toolName === "todoWriteTool";
  const toolColor = getToolCallColor(item.toolName);
  const name = argumentStart === -1 ? item.call.text : item.call.text.slice(0, argumentStart);
  const argumentsText = argumentStart === -1 ? "" : item.call.text.slice(argumentStart);

  return (
    <Text>
      {prefix ? <Text color="gray">{prefix}</Text> : null}
      <Text color={toolColor}>● </Text>
      <Text bold color={isTodo ? toolColor : "white"}>
        {name}
      </Text>
      {argumentsText ? <Text color={isTodo ? toolColor : "gray"}>{argumentsText}</Text> : null}
      {isTodo && item.result === undefined ? <Text color={toolColor}>…</Text> : null}
    </Text>
  );
}

function ToolResultView({
  result,
  resultIndent,
  toolName,
}: {
  readonly result: MessageContent;
  readonly resultIndent: number;
  readonly toolName: string;
}) {
  if (toolName === "todoWriteTool" && result.details && result.details.length > 0) {
    return <TodoResultView result={result} resultIndent={resultIndent} />;
  }

  const resultColor = getResultColor(result.text);

  return (
    <Box flexDirection="column" marginLeft={resultIndent}>
      <Text>
        <Text color="gray">{TOOL_RESULT_PREFIX}</Text>
        <Text color={resultColor}>{result.text}</Text>
      </Text>
      {result.details?.map((line, index) => (
        <Text
          color={result.detailColors?.[index] ?? getDetailLineColor(line)}
          key={`${line}:${line.length}`}
        >
          {TOOL_DETAIL_PREFIX}
          {line}
        </Text>
      ))}
    </Box>
  );
}

function TodoResultView({
  result,
  resultIndent,
}: {
  readonly result: MessageContent;
  readonly resultIndent: number;
}) {
  const details = result.details ?? [];

  return (
    <Box flexDirection="column" marginLeft={resultIndent}>
      {details.map((line, index) => (
        <Text
          color={result.detailColors?.[index] ?? getDetailLineColor(line)}
          key={`${line}:${line.length}`}
        >
          <Text color="gray">{index === details.length - 1 ? "└" : "├"}</Text>
          {line}
        </Text>
      ))}
      <Text color="gray">│</Text>
      <Text>
        <Text color="gray">└ </Text>
        {result.text}
      </Text>
    </Box>
  );
}

export function getToolCallColor(toolName: string): MessageColor {
  return toolName === "todoWriteTool" ? "magenta" : "green";
}

export function getResultColor(text: string): MessageColor {
  return text.startsWith("Error:") ? "red" : "white";
}

export function getDetailLineColor(line: string): MessageColor {
  if (line.startsWith("... (+")) {
    return "gray";
  }

  if (line.startsWith("+ ") || line.startsWith("✓ ")) {
    return "green";
  }

  if (line.startsWith("- ") || line.startsWith("Error:")) {
    return "red";
  }

  if (line.startsWith("● ")) {
    return "yellow";
  }

  return "white";
}
