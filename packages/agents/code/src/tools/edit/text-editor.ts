import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import { formatNumberedLines, truncateOutput } from "../common/output.js";
import { PathBoundary, type PathIdentity } from "../common/path-boundary.js";
import {
  getOffsetAfterLine,
  requireDefined,
  requireNonEmpty,
  requireNonNegativeInteger,
} from "../common/validation.js";
import { WorkspaceContext } from "../common/workspace-context.js";
import type { TextReadOperationInput, TextReadOperationResult } from "../read/types.js";
import {
  DEFAULT_TEXT_EDITOR_MAX_CHARACTERS,
  type TextEditOperationInput,
  type TextEditOperationResult,
  type TextEditorOptions,
  type TextEditorToolExecutor,
  type TextEditorToolInput,
  type TextWriteOperationInput,
  type TextWriteOperationResult,
} from "./types.js";

interface TextEditBehavior {
  readonly allowUnchanged?: boolean | undefined;
  readonly missingMessage?: string | undefined;
  readonly multipleMessage?: string | undefined;
}

export class TextFileOperations {
  private readonly maxCharacters: number;
  private readonly pathBoundary: PathBoundary;
  private readonly workspace: WorkspaceContext;

  public constructor(options: TextEditorOptions = {}) {
    this.maxCharacters = options.maxCharacters ?? DEFAULT_TEXT_EDITOR_MAX_CHARACTERS;
    this.workspace =
      options.workspace ??
      new WorkspaceContext({
        accessMode: options.readOnly === true ? "read-only" : "read-write",
        rootDir: options.rootDir ?? process.cwd(),
      });
    this.pathBoundary = new PathBoundary({ workspace: this.workspace });
  }

  public async read(input: TextReadOperationInput): Promise<TextReadOperationResult> {
    const filePath = await this.pathBoundary.resolveExistingPath(input.filePath);
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      return {
        content: truncateOutput(await this.viewDirectory(filePath), this.maxCharacters),
        filePath: this.pathBoundary.relative(filePath),
        startLine: 1,
      };
    }
    if (!stat.isFile()) {
      throw new Error("file_path must reference a file or directory.");
    }
    const fileText = await fs.readFile(filePath, "utf8");
    const lineRange = toFocusedLineRange(input.lineStart, input.lineEnd);

    return {
      content: truncateOutput(formatNumberedLines(fileText, lineRange), this.maxCharacters),
      filePath: this.pathBoundary.relative(filePath),
      startLine: lineRange?.[0] ?? 1,
    };
  }

  public async edit(
    input: TextEditOperationInput,
    behavior: TextEditBehavior = {},
  ): Promise<TextEditOperationResult> {
    await this.requireWrite(input.filePath);
    if (input.oldText.length === 0) {
      throw new Error("old_string is required.");
    }
    if (input.oldText === input.newText && behavior.allowUnchanged !== true) {
      throw new Error("old_string and new_string must be different.");
    }

    const writable = await this.pathBoundary.resolveWritablePath(input.filePath);
    const fileText = await fs.readFile(writable.path, "utf8");
    const matchCount = countOccurrences(fileText, input.oldText);
    if (matchCount === 0) {
      throw new Error(behavior.missingMessage ?? "old_string was not found in the file.");
    }
    if (matchCount > 1 && input.replaceAll !== true) {
      throw new Error(
        behavior.multipleMessage ??
          "old_string matched multiple locations. Set replace_all or provide more context.",
      );
    }
    const matchOffset = fileText.indexOf(input.oldText);
    const updatedText =
      input.replaceAll === true
        ? fileText.replaceAll(input.oldText, input.newText)
        : fileText.replace(input.oldText, input.newText);

    await this.atomicReplace(writable.path, writable.identity, updatedText);

    return {
      filePath: this.pathBoundary.relative(writable.path),
      matchCount,
      newText: input.newText,
      oldText: input.oldText,
      startLine: getLineNumber(fileText, matchOffset),
    };
  }

  public async write(input: TextWriteOperationInput): Promise<TextWriteOperationResult> {
    await this.requireWrite(input.filePath);
    const newText = ensureFinalNewline(input.content);

    try {
      const writable = await this.pathBoundary.resolveWritablePath(input.filePath);
      const stat = await fs.stat(writable.path);
      if (!stat.isFile()) {
        throw new Error("file_path must reference a file.");
      }
      const oldText = await fs.readFile(writable.path, "utf8");
      await this.atomicReplace(writable.path, writable.identity, newText);

      return {
        filePath: this.pathBoundary.relative(writable.path),
        newText,
        oldText,
        writeType: "replace",
      };
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }

    const filePath = await this.prepareCreatablePath(input.filePath);
    try {
      await this.atomicCreate(filePath, newText);
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        throw new Error("File changed before the write completed.");
      }
      throw error;
    }

    return {
      filePath: this.pathBoundary.relative(filePath),
      newText,
      oldText: "",
      writeType: "create",
    };
  }

  public async view(inputPath: string, viewRange?: readonly number[] | undefined): Promise<string> {
    const filePath = await this.pathBoundary.resolveExistingPath(inputPath);
    const stat = await fs.stat(filePath);

    if (stat.isDirectory()) {
      return truncateOutput(await this.viewDirectory(filePath), this.maxCharacters);
    }

    if (!stat.isFile()) {
      throw new Error("Path must reference a file or directory.");
    }

    const fileText = await fs.readFile(filePath, "utf8");

    return truncateOutput(
      formatNumberedLines(fileText, toLineRange(viewRange)),
      this.maxCharacters,
    );
  }

  public async create(inputPath: string, fileText: string): Promise<string> {
    await this.requireWrite(inputPath);
    const filePath = await this.prepareCreatablePath(inputPath);
    try {
      await this.atomicCreate(filePath, fileText);
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        throw new Error("File already exists.");
      }
      throw error;
    }

    return this.pathBoundary.relative(filePath);
  }

  public async insert(inputPath: string, insertLine: number, insertText: string): Promise<void> {
    await this.requireWrite(inputPath);
    const writable = await this.pathBoundary.resolveWritablePath(inputPath);
    const fileText = await fs.readFile(writable.path, "utf8");
    const offset = getOffsetAfterLine(fileText, insertLine);
    const followingText = fileText.slice(offset);
    const normalizedInsertText =
      insertText.length > 0 && followingText.length > 0 && !insertText.endsWith("\n")
        ? `${insertText}\n`
        : insertText;

    await this.atomicReplace(
      writable.path,
      writable.identity,
      `${fileText.slice(0, offset)}${normalizedInsertText}${followingText}`,
    );
  }

  private async viewDirectory(directoryPath: string): Promise<string> {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    const lines = entries
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
      .sort((left, right) => left.localeCompare(right));

    return [`Directory ${this.pathBoundary.relative(directoryPath)}:`, ...lines].join("\n");
  }

  private async prepareCreatablePath(inputPath: string): Promise<string> {
    let filePath = await this.pathBoundary.resolveCreatablePath(inputPath);
    await fs.mkdir(dirname(filePath), { recursive: true });
    filePath = await this.pathBoundary.resolveCreatablePath(inputPath);
    return filePath;
  }

  private async atomicCreate(filePath: string, fileText: string): Promise<void> {
    const temporaryPath = temporaryFilePath(filePath);
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(temporaryPath, "wx", 0o644);
      await handle.writeFile(fileText);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.link(temporaryPath, filePath);
      await this.pathBoundary.resolveExistingPath(filePath);
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporaryPath).catch(() => undefined);
    }
  }

  private async atomicReplace(
    filePath: string,
    identity: PathIdentity,
    fileText: string,
  ): Promise<void> {
    const temporaryPath = temporaryFilePath(filePath);
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(temporaryPath, "wx", identity.mode & 0o777);
      await handle.writeFile(fileText);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.pathBoundary.assertUnchanged(filePath, identity);
      await fs.rename(temporaryPath, filePath);
      await this.pathBoundary.resolveExistingPath(filePath);
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporaryPath).catch(() => undefined);
    }
  }

  private requireWrite(subject: string): Promise<void> {
    return this.workspace.accessController.requireWrite({
      action: "edit",
      subject,
      workspaceId: this.workspace.workspaceId,
    });
  }
}

export class TextEditor implements TextEditorToolExecutor {
  private readonly operations: TextFileOperations;

  public constructor(options: TextEditorOptions = {}) {
    this.operations = new TextFileOperations(options);
  }

  public async execute(input: TextEditorToolInput): Promise<string> {
    switch (input.command) {
      case "view":
        return await this.operations.view(input.path, input.view_range);
      case "str_replace": {
        const oldString = requireNonEmpty(input.old_str ?? "", "old_str is required.");
        await this.operations.edit(
          {
            filePath: input.path,
            newText: input.new_str ?? "",
            oldText: oldString,
          },
          {
            allowUnchanged: true,
            missingMessage: "old_str was not found in the file.",
            multipleMessage: "old_str matched multiple locations. Provide a unique string.",
          },
        );
        return "Successfully replaced text at exactly one location.";
      }
      case "create": {
        const relativePath = await this.operations.create(input.path, input.file_text ?? "");
        return `Successfully created file at ${relativePath}.`;
      }
      case "insert": {
        const insertLine = requireNonNegativeInteger(
          requireDefined(input.insert_line, "insert_line is required."),
          "insert_line must be greater than or equal to 0.",
        );
        await this.operations.insert(input.path, insertLine, input.insert_text ?? "");
        return `Successfully inserted text after line ${insertLine}.`;
      }
    }
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ENOTDIR")
  );
}

function countOccurrences(text: string, search: string): number {
  let count = 0;
  let offset = text.indexOf(search);
  while (offset !== -1) {
    count += 1;
    offset = text.indexOf(search, offset + search.length);
  }
  return count;
}

function ensureFinalNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function getLineNumber(text: string, offset: number): number {
  let lineNumber = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === "\n") {
      lineNumber += 1;
    }
  }
  return lineNumber;
}

function temporaryFilePath(filePath: string): string {
  return join(dirname(filePath), `.${basename(filePath)}.yiku-${randomUUID()}.tmp`);
}

function toFocusedLineRange(
  lineStart: number | undefined,
  lineEnd: number | undefined,
): readonly [number, number] | undefined {
  if (lineStart === undefined && lineEnd === undefined) {
    return undefined;
  }
  const start = lineStart ?? 1;
  const end = lineEnd ?? -1;
  if (!Number.isInteger(start) || start < 1) {
    throw new Error("line_start must be greater than or equal to 1.");
  }
  if (!Number.isInteger(end) || (end !== -1 && end < start)) {
    throw new Error("line_end must be -1 or greater than or equal to line_start.");
  }
  return [start, end];
}

function toLineRange(
  viewRange: readonly number[] | undefined,
): readonly [number, number] | undefined {
  if (viewRange === undefined) {
    return undefined;
  }

  const [startLine, endLine] = viewRange;

  if (viewRange.length !== 2 || startLine === undefined || endLine === undefined) {
    throw new Error("view_range must contain exactly two line numbers.");
  }

  return [startLine, endLine];
}
