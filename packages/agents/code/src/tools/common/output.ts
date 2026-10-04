import { resolveLineRange } from "./validation.js";

export interface TruncatedText {
  readonly text: string;
  readonly truncated: boolean;
}

export function formatAgentOutput(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }

  if (output == null) {
    return "";
  }

  const serialized = JSON.stringify(output, null, 2);

  return serialized ?? String(output);
}

export function truncateText(text: string, maxCharacters: number): TruncatedText {
  if (text.length <= maxCharacters) {
    return {
      text,
      truncated: false,
    };
  }

  return {
    text: text.slice(0, maxCharacters),
    truncated: true,
  };
}

export function truncateOutput(text: string, maxCharacters: number): string {
  const truncated = truncateText(text, maxCharacters);

  if (!truncated.truncated) {
    return truncated.text;
  }

  return `${truncated.text}\n[truncated after ${maxCharacters} characters]`;
}

export function formatNumberedLines(
  fileText: string,
  viewRange: readonly [number, number] | undefined,
): string {
  const lines = splitDisplayLines(fileText);
  const { endLine, startLine } = resolveLineRange(lines.length, viewRange);

  return lines
    .slice(startLine - 1, endLine)
    .map((line, index) => `${startLine + index}: ${line}`)
    .join("\n");
}

export function formatToolError(error: unknown): string {
  return error instanceof Error ? `Error: ${error.message}` : `Error: ${String(error)}`;
}

function splitDisplayLines(fileText: string): string[] {
  if (!fileText) {
    return [""];
  }

  const lines = fileText.split(/\r?\n/);

  return fileText.endsWith("\n") ? lines.slice(0, -1) : lines;
}
