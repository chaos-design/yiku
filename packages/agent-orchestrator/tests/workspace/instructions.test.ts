import { describe, expect, it } from "vitest";
import { InstructionLoader } from "../../src/workspace/instructions.js";

describe("InstructionLoader", () => {
  it("loads nested includes once with explicit reasons", async () => {
    const files = new Map([
      ["/workspace/CLAUDE.md", "Root\n@rules/code.md\n@rules/code.md"],
      ["/workspace/rules/code.md", "Code rules\n@shared.md"],
      ["/workspace/rules/shared.md", "Shared rules"],
    ]);
    const loader = new InstructionLoader({
      read: async (path) => {
        const content = files.get(path);
        if (content === undefined) {
          throw new Error(`missing ${path}`);
        }
        return content;
      },
      workspaceDir: "/workspace",
    });

    await expect(loader.load(["CLAUDE.md"], "session_start")).resolves.toEqual([
      {
        content: "Root\n@rules/code.md\n@rules/code.md",
        loadReason: "session_start",
        path: "/workspace/CLAUDE.md",
      },
      {
        content: "Code rules\n@shared.md",
        loadReason: "include",
        path: "/workspace/rules/code.md",
      },
      {
        content: "Shared rules",
        loadReason: "include",
        path: "/workspace/rules/shared.md",
      },
    ]);
  });

  it("rejects workspace escapes, excessive depth, and excessive bytes", async () => {
    const boundary = new InstructionLoader({
      read: async () => "content",
      workspaceDir: "/workspace",
    });
    await expect(boundary.load(["../secret.md"], "session_start")).rejects.toThrow("escapes");

    const depth = new InstructionLoader({
      maxDepth: 1,
      read: async (path) => (path.endsWith("a.md") ? "@b.md" : "@c.md"),
      workspaceDir: "/workspace",
    });
    await expect(depth.load(["a.md"], "session_start")).rejects.toThrow("depth");

    const bytes = new InstructionLoader({
      maxBytes: 3,
      read: async () => "four",
      workspaceDir: "/workspace",
    });
    await expect(bytes.load(["a.md"], "session_start")).rejects.toThrow("bytes");
  });

  it("ignores URL-like and whitespace-bearing include lines", async () => {
    const loader = new InstructionLoader({
      read: async () => "@https://example.test\n@not an include",
      workspaceDir: "/workspace",
    });

    await expect(loader.load(["CLAUDE.md"], "session_start")).resolves.toHaveLength(1);
  });
});
