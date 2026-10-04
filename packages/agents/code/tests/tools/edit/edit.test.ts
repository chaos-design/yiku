import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceAccessController } from "../../../src/permission/workspace-access.js";
import { WorkspaceContext } from "../../../src/tools/common/workspace-context.js";
import { textEditorTool } from "../../../src/tools/edit/index.js";
import { TextEditor } from "../../../src/tools/edit/text-editor.js";
import {
  TEXT_EDITOR_TOOL_DEFINITION,
  textEditorToolInputSchema,
} from "../../../src/tools/edit/types.js";

describe("TextEditor", () => {
  it("views directories and files with line numbers", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "yiku-editor-"));
    const editor = new TextEditor({ rootDir: tempDir });

    try {
      await writeFile(join(tempDir, "sample.txt"), "alpha\nbeta\ngamma\n");

      await expect(editor.execute({ command: "view", path: "." })).resolves.toContain("sample.txt");
      await expect(
        editor.execute({ command: "view", path: "sample.txt", view_range: [2, -1] }),
      ).resolves.toBe("2: beta\n3: gamma");
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("creates, inserts, and replaces text files", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "yiku-editor-"));
    const editor = new TextEditor({ rootDir: tempDir });

    try {
      await expect(
        editor.execute({
          command: "create",
          file_text: "alpha\ngamma\n",
          path: "nested/sample.txt",
        }),
      ).resolves.toBe("Successfully created file at nested/sample.txt.");
      await expect(
        editor.execute({
          command: "insert",
          insert_line: 1,
          insert_text: "beta",
          path: "nested/sample.txt",
        }),
      ).resolves.toBe("Successfully inserted text after line 1.");
      await expect(
        editor.execute({
          command: "str_replace",
          new_str: "delta",
          old_str: "gamma",
          path: "nested/sample.txt",
        }),
      ).resolves.toBe("Successfully replaced text at exactly one location.");
      await expect(readFile(join(tempDir, "nested/sample.txt"), "utf8")).resolves.toBe(
        "alpha\nbeta\ndelta\n",
      );
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("rejects unsafe paths and ambiguous edits", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "yiku-editor-"));
    const editor = new TextEditor({ rootDir: tempDir, maxCharacters: 5 });

    try {
      await writeFile(join(tempDir, "sample.txt"), "same\nsame\n");

      await expect(editor.execute({ command: "view", path: "../outside.txt" })).rejects.toThrow(
        "Path must stay within the configured root directory.",
      );
      await expect(
        editor.execute({
          command: "str_replace",
          new_str: "next",
          old_str: "same",
          path: "sample.txt",
        }),
      ).rejects.toThrow("old_str matched multiple locations. Provide a unique string.");
      await expect(editor.execute({ command: "view", path: "sample.txt" })).resolves.toBe(
        "1: sa\n[truncated after 5 characters]",
      );
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("rejects invalid edit arguments", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "yiku-editor-"));
    const editor = new TextEditor({ rootDir: tempDir });

    try {
      await writeFile(join(tempDir, "sample.txt"), "alpha\nbeta");

      await expect(
        editor.execute({ command: "create", file_text: "next", path: "sample.txt" }),
      ).rejects.toThrow("File already exists.");
      await expect(
        editor.execute({
          command: "str_replace",
          new_str: "next",
          old_str: "missing",
          path: "sample.txt",
        }),
      ).rejects.toThrow("old_str was not found in the file.");
      await expect(editor.execute({ command: "str_replace", path: "sample.txt" })).rejects.toThrow(
        "old_str is required.",
      );
      await expect(editor.execute({ command: "insert", path: "sample.txt" })).rejects.toThrow(
        "insert_line is required.",
      );
      await expect(
        editor.execute({ command: "insert", insert_line: -1, path: "sample.txt" }),
      ).rejects.toThrow("insert_line must be greater than or equal to 0.");
      await expect(
        editor.execute({ command: "insert", insert_line: 99, path: "sample.txt" }),
      ).rejects.toThrow("insert_line 99 is outside the file range.");
      await expect(
        editor.execute({ command: "view", path: "sample.txt", view_range: [0, -1] }),
      ).rejects.toThrow("view_range start must be greater than or equal to 1.");
      await expect(
        editor.execute({ command: "view", path: "sample.txt", view_range: [2, 1] }),
      ).rejects.toThrow("view_range end must be -1 or greater than or equal to the start line.");
      await expect(
        editor.execute({ command: "view", path: "sample.txt", view_range: [1] }),
      ).rejects.toThrow("view_range must contain exactly two line numbers.");
      await expect(editor.execute({ command: "view", path: "" })).rejects.toThrow(
        "path is required.",
      );
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("asks once before upgrading a read-only editor", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "yiku-editor-read-only-"));
    const approvalHandler = vi.fn(async () => ({
      decision: "allow" as const,
      persistence: "session" as const,
    }));
    const accessController = new WorkspaceAccessController({
      accessMode: "read-only",
      approvalHandler,
    });
    const editor = new TextEditor({
      workspace: new WorkspaceContext({
        accessController,
        rootDir: tempDir,
      }),
    });

    try {
      await writeFile(join(tempDir, "sample.txt"), "alpha\n");

      await expect(editor.execute({ command: "view", path: "sample.txt" })).resolves.toContain(
        "alpha",
      );
      await expect(
        editor.execute({ command: "create", file_text: "blocked", path: "blocked.txt" }),
      ).resolves.toContain("Successfully created");
      await expect(
        editor.execute({ command: "create", file_text: "next", path: "next.txt" }),
      ).resolves.toContain("Successfully created");
      expect(approvalHandler).toHaveBeenCalledOnce();
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });
});

describe("textEditorTool", () => {
  it("creates an atomic text editor function tool", () => {
    const editTool = textEditorTool({
      executor: {
        execute: async () => "ok",
      },
    });

    expect(TEXT_EDITOR_TOOL_DEFINITION).toEqual({
      max_characters: 20_000,
      name: "textEditorTool",
      type: "text_editor_20250728",
    });
    expect(editTool.name).toBe("textEditorTool");
    expect(editTool.parameters).toBeDefined();
    expect(textEditorToolInputSchema.parse({ command: "view", path: "file.ts" })).toEqual({
      command: "view",
      path: "file.ts",
    });
    expect(
      textEditorToolInputSchema.parse({
        command: "view",
        path: "file.ts",
        view_range: [1, -1],
      }),
    ).toEqual({
      command: "view",
      path: "file.ts",
      view_range: [1, -1],
    });
    expect(() =>
      textEditorToolInputSchema.parse({
        command: "view",
        path: "file.ts",
        view_range: [1],
      }),
    ).toThrow();
  });

  it("invokes the executor and formats tool errors", async () => {
    const editTool = textEditorTool({
      executor: {
        execute: async (input) => {
          if (input.path === "fail.txt") {
            throw new Error("failed edit");
          }

          return `ran ${input.command}`;
        },
      },
    });

    await expect(
      editTool.invoke({} as never, JSON.stringify({ command: "view", path: "file.txt" })),
    ).resolves.toBe("ran view");
    await expect(
      editTool.invoke({} as never, JSON.stringify({ command: "view", path: "fail.txt" })),
    ).resolves.toBe("Error: failed edit");
  });

  it("accepts persisted transcript inputs with unrelated empty fields", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "yiku-editor-persisted-"));
    const legacy = textEditorTool({ rootDir: tempDir });

    try {
      await writeFile(join(tempDir, "sample.ts"), "old\nvalue\n");

      const viewResult = await legacy.invoke(
        {} as never,
        JSON.stringify({
          command: "view",
          file_text: "",
          insert_line: 0,
          insert_text: "",
          new_str: "",
          old_str: "",
          path: "sample.ts",
          view_range: [],
        }),
      );
      expect(viewResult).toContain("1: old");
      expect(viewResult).not.toContain("Invalid JSON input");

      const replaceResult = await legacy.invoke(
        {} as never,
        JSON.stringify({
          command: "str_replace",
          file_text: "",
          insert_line: 0,
          insert_text: "",
          new_str: "next\nvalue",
          old_str: "old\nvalue",
          path: "sample.ts",
          view_range: [],
        }),
      );
      expect(replaceResult).toContain("Successfully replaced");
      expect(replaceResult).not.toContain("Invalid JSON input");
      await expect(readFile(join(tempDir, "sample.ts"), "utf8")).resolves.toBe("next\nvalue\n");
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });
});
