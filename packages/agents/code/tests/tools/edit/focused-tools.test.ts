import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { editTool, writeTool } from "../../../src/tools/edit/index.js";
import { editToolInputSchema, writeToolInputSchema } from "../../../src/tools/edit/types.js";
import { readTool, readToolInputSchema } from "../../../src/tools/read/index.js";

describe("focused file tool schemas", () => {
  it("accepts only each tool's focused fields", () => {
    expect(
      readToolInputSchema.parse({
        file_path: "sample.txt",
        line_end: -1,
        line_start: 2,
      }),
    ).toEqual({
      file_path: "sample.txt",
      line_end: -1,
      line_start: 2,
    });
    expect(
      editToolInputSchema.parse({
        file_path: "sample.txt",
        new_string: "next",
        old_string: "current",
        replace_all: true,
      }),
    ).toEqual({
      file_path: "sample.txt",
      new_string: "next",
      old_string: "current",
      replace_all: true,
    });
    expect(
      writeToolInputSchema.parse({
        content: "content",
        file_path: "sample.txt",
      }),
    ).toEqual({
      content: "content",
      file_path: "sample.txt",
    });

    expect(() =>
      readToolInputSchema.parse({ content: "extra", file_path: "sample.txt" }),
    ).toThrow();
    expect(() =>
      editToolInputSchema.parse({
        content: "extra",
        file_path: "sample.txt",
        new_string: "next",
        old_string: "current",
      }),
    ).toThrow();
    expect(() =>
      writeToolInputSchema.parse({
        content: "content",
        file_path: "sample.txt",
        replace_all: true,
      }),
    ).toThrow();
    expect(() =>
      readToolInputSchema.parse({
        file_path: "sample.txt",
        line_end: 1,
        line_start: 2,
      }),
    ).toThrow();
  });
});

describe("Read", () => {
  it("reads an inclusive line range and supports -1 as the final line", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "yiku-focused-read-"));
    const tool = readTool({ rootDir: tempDir });

    try {
      await writeFile(join(tempDir, "sample.txt"), "alpha\nbeta\ngamma\n");

      await expect(
        tool.invoke(
          JSON.stringify({
            file_path: "sample.txt",
            line_end: -1,
            line_start: 2,
          }),
        ),
      ).resolves.toEqual({
        isError: false,
        llmContent: "2: beta\n3: gamma",
        metadata: {
          filePath: "sample.txt",
          startLine: 2,
        },
      });
      expect(tool.name).toBe("readTool");
      expect(tool.effect).toBe("read");
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("returns structured validation, JSON, and execution errors", async () => {
    const nonErrorRead = readTool({
      executor: {
        read: async () => Promise.reject("read failed"),
      },
    });
    await expect(nonErrorRead.invoke("{bad")).resolves.toMatchObject({
      error: { code: "TOOL_JSON_SYNTAX_ERROR" },
      isError: true,
    });
    await expect(nonErrorRead.run({ file_path: "" })).resolves.toMatchObject({
      error: {
        code: "TOOL_INPUT_VALIDATION_ERROR",
        issues: [expect.objectContaining({ path: "file_path" })],
      },
      isError: true,
    });
    await expect(nonErrorRead.run({ file_path: "sample.txt" })).resolves.toEqual({
      error: { code: "TOOL_EXECUTION_ERROR" },
      isError: true,
      llmContent: "read failed",
    });

    const throwingMiddleware = {
      run: async () => {
        throw new Error("middleware failed");
      },
    };
    await expect(
      readTool({ middleware: throwingMiddleware }).run(
        { file_path: "sample.txt" },
        { callId: "call-1", signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({
      error: { code: "TOOL_EXECUTION_ERROR" },
      isError: true,
      llmContent: "Tool execution failed: middleware failed",
    });
  });
});

describe("Edit", () => {
  it("requires a unique match unless replace_all is true", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "yiku-focused-edit-"));
    const tool = editTool({ rootDir: tempDir });

    try {
      await writeFile(join(tempDir, "sample.txt"), "alpha\nsame\nsame\nomega\n");

      await expect(
        tool.invoke(
          JSON.stringify({
            file_path: "sample.txt",
            new_string: "next",
            old_string: "same",
            replace_all: false,
          }),
        ),
      ).resolves.toMatchObject({
        error: { code: "TOOL_EXECUTION_ERROR" },
        isError: true,
        llmContent: expect.stringContaining("replace_all"),
      });
      await expect(
        tool.invoke(
          JSON.stringify({
            file_path: "sample.txt",
            new_string: "same",
            old_string: "same",
            replace_all: false,
          }),
        ),
      ).resolves.toMatchObject({
        error: { code: "TOOL_EXECUTION_ERROR" },
        isError: true,
        llmContent: expect.stringContaining("must be different"),
      });

      await expect(
        tool.invoke(
          JSON.stringify({
            file_path: "sample.txt",
            new_string: "next",
            old_string: "same",
            replace_all: true,
          }),
        ),
      ).resolves.toEqual({
        display: {
          filePath: "sample.txt",
          newText: "next",
          oldText: "same",
          startLine: 2,
          type: "diff",
          writeType: "update",
        },
        isError: false,
        llmContent: "File sample.txt successfully edited.",
        metadata: {
          filePath: "sample.txt",
          matchCount: 2,
        },
      });
      await expect(readFile(join(tempDir, "sample.txt"), "utf8")).resolves.toBe(
        "alpha\nnext\nnext\nomega\n",
      );
      expect(tool.name).toBe("editTool");
      expect(tool.effect).toBe("write");
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("wraps non-Error executor failures", async () => {
    const tool = editTool({
      executor: {
        edit: async () => Promise.reject("edit failed"),
      },
    });
    await expect(
      tool.run({
        file_path: "sample.txt",
        new_string: "next",
        old_string: "before",
        replace_all: false,
      }),
    ).resolves.toEqual({
      error: { code: "TOOL_EXECUTION_ERROR" },
      isError: true,
      llmContent: "edit failed",
    });
  });
});

describe("Write", () => {
  it("atomically creates and replaces files with a final newline", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "yiku-focused-write-"));
    const tool = writeTool({ rootDir: tempDir });

    try {
      await expect(
        tool.invoke(
          JSON.stringify({
            content: "alpha",
            file_path: "nested/sample.txt",
          }),
        ),
      ).resolves.toEqual({
        display: {
          filePath: "nested/sample.txt",
          newText: "alpha\n",
          oldText: "",
          startLine: 1,
          type: "diff",
          writeType: "add",
        },
        isError: false,
        llmContent: "File nested/sample.txt successfully written.",
        metadata: {
          filePath: "nested/sample.txt",
          writeType: "create",
        },
      });
      await expect(readFile(join(tempDir, "nested/sample.txt"), "utf8")).resolves.toBe("alpha\n");

      await expect(
        tool.invoke(
          JSON.stringify({
            content: "beta\n",
            file_path: "nested/sample.txt",
          }),
        ),
      ).resolves.toEqual({
        display: {
          filePath: "nested/sample.txt",
          newText: "beta\n",
          oldText: "alpha\n",
          startLine: 1,
          type: "diff",
          writeType: "update",
        },
        isError: false,
        llmContent: "File nested/sample.txt successfully written.",
        metadata: {
          filePath: "nested/sample.txt",
          writeType: "replace",
        },
      });
      await expect(readFile(join(tempDir, "nested/sample.txt"), "utf8")).resolves.toBe("beta\n");
      await expect(readdir(join(tempDir, "nested"))).resolves.toEqual(["sample.txt"]);
      expect(tool.name).toBe("writeTool");
      expect(tool.effect).toBe("write");
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("wraps Error executor failures", async () => {
    const tool = writeTool({
      executor: {
        write: async () => {
          throw new Error("write failed");
        },
      },
    });
    await expect(
      tool.run({
        content: "content",
        file_path: "sample.txt",
      }),
    ).resolves.toEqual({
      error: { code: "TOOL_EXECUTION_ERROR" },
      isError: true,
      llmContent: "write failed",
    });
  });
});
