export function requireNonEmpty(value: string, message: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error(message);
  }

  return trimmed;
}

export function requireDefined<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }

  return value;
}

export function requireNonNegativeInteger(value: number, message: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(message);
  }

  return value;
}

export function requireUniqueOccurrence(
  text: string,
  search: string,
  messages: {
    readonly missing: string;
    readonly multiple: string;
  },
): void {
  const matchCount = countOccurrences(text, search);

  if (matchCount === 0) {
    throw new Error(messages.missing);
  }

  if (matchCount > 1) {
    throw new Error(messages.multiple);
  }
}

export function resolveLineRange(
  lineCount: number,
  viewRange: readonly [number, number] | undefined,
): {
  readonly endLine: number;
  readonly startLine: number;
} {
  const startLine = viewRange?.[0] ?? 1;
  const endLine = viewRange?.[1] ?? -1;

  if (startLine < 1) {
    throw new Error("view_range start must be greater than or equal to 1.");
  }

  if (endLine !== -1 && endLine < startLine) {
    throw new Error("view_range end must be -1 or greater than or equal to the start line.");
  }

  return {
    endLine: endLine === -1 ? lineCount : Math.min(endLine, lineCount),
    startLine,
  };
}

export function getOffsetAfterLine(fileText: string, lineNumber: number): number {
  if (lineNumber === 0) {
    return 0;
  }

  let currentLine = 1;

  for (let index = 0; index < fileText.length; index += 1) {
    if (fileText[index] === "\n") {
      if (currentLine === lineNumber) {
        return index + 1;
      }

      currentLine += 1;
    }
  }

  if (currentLine === lineNumber && fileText.length > 0) {
    return fileText.length;
  }

  throw new Error(`insert_line ${lineNumber} is outside the file range.`);
}

function countOccurrences(text: string, search: string): number {
  let count = 0;
  let index = text.indexOf(search);

  while (index !== -1) {
    count += 1;
    index = text.indexOf(search, index + search.length);
  }

  return count;
}
