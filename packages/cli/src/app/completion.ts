import { clampCursorIndex } from "../prompts/prompt-preview.js";

export interface FileCompletionQuery {
  readonly endIndex: number;
  readonly query: string;
  readonly startIndex: number;
}

export interface ShellCommandQuery {
  readonly command: string;
  readonly startIndex: number;
}

export interface ApplyCompletionResult {
  readonly cursorIndex: number;
  readonly value: string;
}

const TOKEN_BOUNDARY_PATTERN = /\s/;

export function getShellCommandQuery(input: string): ShellCommandQuery | undefined {
  const startIndex = input.search(/\S/u);

  if (startIndex < 0 || input.charAt(startIndex) !== "!") {
    return undefined;
  }

  return {
    command: input.slice(startIndex + 1),
    startIndex,
  };
}

export function getFileCompletionQuery(
  input: string,
  cursorIndex: number,
): FileCompletionQuery | undefined {
  const resolvedCursorIndex = clampCursorIndex(cursorIndex, input);
  const textBeforeCursor = input.slice(0, resolvedCursorIndex);
  const atIndex = textBeforeCursor.lastIndexOf("@");

  if (atIndex < 0) {
    return undefined;
  }

  const charBeforeAt = atIndex > 0 ? input.charAt(atIndex - 1) : "";

  if (charBeforeAt && !TOKEN_BOUNDARY_PATTERN.test(charBeforeAt)) {
    return undefined;
  }

  const query = textBeforeCursor.slice(atIndex + 1);

  if (TOKEN_BOUNDARY_PATTERN.test(query)) {
    return undefined;
  }

  return {
    endIndex: resolvedCursorIndex,
    query,
    startIndex: atIndex,
  };
}

export function applyFileCompletion(
  input: string,
  completion: FileCompletionQuery,
  insertValue: string,
): ApplyCompletionResult {
  const suffix = insertValue.endsWith("/") ? "" : " ";
  const nextValueStart = `${input.slice(0, completion.startIndex)}@${insertValue}${suffix}`;
  const value = `${nextValueStart}${input.slice(completion.endIndex)}`;

  return {
    cursorIndex: nextValueStart.length,
    value,
  };
}
