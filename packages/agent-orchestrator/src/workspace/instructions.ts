import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { InstructionsLoadedHookEvent } from "@yiku/hooks";

export interface InstructionDocument {
  readonly content: string;
  readonly loadReason: InstructionsLoadedHookEvent["load_reason"];
  readonly path: string;
}

export interface InstructionLoaderOptions {
  readonly maxBytes?: number | undefined;
  readonly maxDepth?: number | undefined;
  readonly read?: ((path: string) => Promise<string>) | undefined;
  readonly workspaceDir: string;
}

export class InstructionLoader {
  private readonly maxBytes: number;
  private readonly maxDepth: number;
  private readonly read: (path: string) => Promise<string>;
  private readonly workspaceDir: string;

  public constructor(options: InstructionLoaderOptions) {
    this.maxBytes = options.maxBytes ?? 262_144;
    this.maxDepth = options.maxDepth ?? 8;
    this.read = options.read ?? ((path) => readFile(path, "utf8"));
    this.workspaceDir = resolve(options.workspaceDir);
  }

  public async load(
    paths: readonly string[],
    reason: InstructionsLoadedHookEvent["load_reason"],
  ): Promise<readonly InstructionDocument[]> {
    const documents: InstructionDocument[] = [];
    const visited = new Set<string>();
    let totalBytes = 0;

    const visit = async (
      inputPath: string,
      loadReason: InstructionsLoadedHookEvent["load_reason"],
      depth: number,
    ): Promise<void> => {
      if (depth > this.maxDepth) {
        throw new Error(`Instruction include depth exceeds ${this.maxDepth}.`);
      }

      const path = this.resolvePath(inputPath);
      if (visited.has(path)) {
        return;
      }
      visited.add(path);

      const content = await this.read(path);
      totalBytes += Buffer.byteLength(content, "utf8");
      if (totalBytes > this.maxBytes) {
        throw new Error(`Instruction content exceeds ${this.maxBytes} bytes.`);
      }

      documents.push(
        Object.freeze({
          content,
          loadReason,
          path,
        }),
      );

      for (const include of parseIncludes(content)) {
        await visit(resolve(dirname(path), include), "include", depth + 1);
      }
    };

    for (const path of paths) {
      await visit(path, reason, 0);
    }

    return Object.freeze(documents);
  }

  private resolvePath(path: string): string {
    const resolved = isAbsolute(path) ? resolve(path) : resolve(this.workspaceDir, path);
    const boundary = relative(this.workspaceDir, resolved);

    if (boundary.startsWith("..") || isAbsolute(boundary)) {
      throw new Error("Instruction path escapes the workspace.");
    }

    return resolved;
  }
}

function parseIncludes(content: string): readonly string[] {
  const includes: string[] = [];

  for (const line of content.replaceAll("\r\n", "\n").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("@") || trimmed.startsWith("@http")) {
      continue;
    }

    const path = trimmed.slice(1).trim();
    if (path && !/\s/u.test(path)) {
      includes.push(path);
    }
  }

  return includes;
}
