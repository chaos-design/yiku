import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { grepFiles } from "../../../src/tools/fs/grep.js";
import { grepTool, lsTool, treeTool } from "../../../src/tools/fs/index.js";
import { listDirectory } from "../../../src/tools/fs/ls.js";
import { buildDirectoryTree } from "../../../src/tools/fs/tree.js";
import {
  fsGrepToolInputSchema,
  fsListToolInputSchema,
  fsTreeToolInputSchema,
} from "../../../src/tools/fs/types.js";

describe("fs tools", () => {
  it("lists directories with default ignored entries", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "yiku-fs-"));

    try {
      await mkdir(join(tempDir, "src"));
      await mkdir(join(tempDir, "node_modules"));
      await writeFile(join(tempDir, "src/index.ts"), "export const value = 1;\n");
      await writeFile(join(tempDir, ".env"), "SECRET=value\n");
      await writeFile(join(tempDir, "README.md"), "# Test\n");

      await expect(listDirectory({ rootDir: tempDir })).resolves.toBe(
        "Directory .:\nsrc/\nREADME.md",
      );
      await expect(listDirectory({ includeHidden: true, rootDir: tempDir })).resolves.toContain(
        ".env",
      );
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("renders a bounded directory tree", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "yiku-fs-"));

    try {
      await mkdir(join(tempDir, "src/nested"), { recursive: true });
      await writeFile(join(tempDir, "src/nested/file.ts"), "hello\n");

      await expect(buildDirectoryTree({ maxDepth: 2, rootDir: tempDir })).resolves.toBe(
        ".\n└── src/\n    └── nested/",
      );
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("handles tree limits and invalid tree paths", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "yiku-fs-"));

    try {
      await mkdir(join(tempDir, "src"));
      await writeFile(join(tempDir, "a.txt"), "a\n");
      await writeFile(join(tempDir, "src/b.txt"), "b\n");

      await expect(buildDirectoryTree({ maxDepth: 0, rootDir: tempDir })).resolves.toBe(".");
      await expect(buildDirectoryTree({ maxEntries: 1, rootDir: tempDir })).resolves.toBe(
        ".\n├── src/\n[truncated after 1 entries]",
      );
      await expect(buildDirectoryTree({ path: "a.txt", rootDir: tempDir })).rejects.toThrow(
        "path must reference a directory.",
      );
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("greps files by literal pattern", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "yiku-fs-"));

    try {
      await mkdir(join(tempDir, "src"));
      await writeFile(join(tempDir, "src/a.ts"), "alpha\nBeta\n");
      await writeFile(join(tempDir, "src/b.ts"), "beta\n");

      await expect(
        grepFiles({ caseSensitive: false, pattern: "beta", rootDir: tempDir }),
      ).resolves.toBe("src/a.ts:2:1: Beta\nsrc/b.ts:1:1: beta");
      await expect(grepFiles({ pattern: "missing", rootDir: tempDir })).resolves.toBe(
        "No matches found.",
      );
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("supports file grep, match limits, and validation", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "yiku-fs-"));

    try {
      await writeFile(join(tempDir, "sample.txt"), "beta one\nbeta two\n");

      await expect(
        grepFiles({ maxResults: 1, path: "sample.txt", pattern: "beta", rootDir: tempDir }),
      ).resolves.toBe("sample.txt:1:1: beta one\n[truncated after 1 matches]");
      await expect(grepFiles({ pattern: "", rootDir: tempDir })).rejects.toThrow(
        "pattern is required.",
      );
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("creates atomic fs function tools", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "yiku-fs-"));

    try {
      await writeFile(join(tempDir, "sample.txt"), "alpha\n");

      const grepFunctionTool = grepTool({ rootDir: tempDir });
      const lsFunctionTool = lsTool({ rootDir: tempDir });
      const treeFunctionTool = treeTool({ rootDir: tempDir });
      expect(lsFunctionTool.name).toBe("lsTool");
      expect(grepFunctionTool.name).toBe("grepTool");
      expect(treeFunctionTool.name).toBe("treeTool");
      expect(lsTool().name).toBe("lsTool");
      expect(grepTool().name).toBe("grepTool");
      expect(treeTool().name).toBe("treeTool");
      expect(fsListToolInputSchema.parse({ path: "." })).toEqual({ path: "." });
      expect(fsTreeToolInputSchema.parse({ max_depth: 1 })).toEqual({ max_depth: 1 });
      expect(fsGrepToolInputSchema.parse({ pattern: "alpha" })).toEqual({ pattern: "alpha" });
      await expect(
        lsFunctionTool.invoke({} as never, JSON.stringify({ path: "." })),
      ).resolves.toContain("sample.txt");
      await expect(
        treeFunctionTool.invoke({} as never, JSON.stringify({ max_depth: 1 })),
      ).resolves.toContain("sample.txt");
      await expect(
        grepFunctionTool.invoke({} as never, JSON.stringify({ pattern: "alpha" })),
      ).resolves.toContain("sample.txt:1:1: alpha");
      await expect(
        lsFunctionTool.invoke({} as never, JSON.stringify({ path: "../outside" })),
      ).resolves.toBe("Error: Path must stay within the configured root directory.");
      await expect(
        treeFunctionTool.invoke({} as never, JSON.stringify({ path: "sample.txt" })),
      ).resolves.toBe("Error: path must reference a directory.");
      await expect(
        grepFunctionTool.invoke({} as never, JSON.stringify({ pattern: "" })),
      ).resolves.toBe("Error: pattern is required.");
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });
});
