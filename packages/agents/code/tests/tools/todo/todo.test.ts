import { describe, expect, it } from "vitest";
import { todoWriteTool } from "../../../src/tools/todo/index.js";
import { TodoList } from "../../../src/tools/todo/tool.js";
import { TODO_STATUSES, todoWriteToolInputSchema } from "../../../src/tools/todo/types.js";

describe("TodoList", () => {
  it("stores and formats todo items", async () => {
    const todoList = new TodoList();

    await expect(
      todoList.write({
        items: [
          { content: "Inspect files", status: "completed" },
          { content: "Apply refactor", status: "in_progress" },
          { content: "Run tests", status: "pending" },
        ],
      }),
    ).resolves.toBe("1. [x] Inspect files\n2. [-] Apply refactor\n3. [ ] Run tests");
  });

  it("validates todo items", async () => {
    const todoList = new TodoList();

    await expect(
      todoList.write({
        items: [
          { content: "One", status: "in_progress" },
          { content: "Two", status: "in_progress" },
        ],
      }),
    ).rejects.toThrow("Only one TODO item can be in_progress.");
    await expect(
      todoList.write({
        items: [{ content: " ", status: "pending" }],
      }),
    ).rejects.toThrow("TODO content is required.");
    await expect(todoList.write({ items: [] })).resolves.toBe("TODO list is empty.");
  });
});

describe("todoWriteTool", () => {
  it("creates a todoWriteTool function tool", async () => {
    const todoTool = todoWriteTool();

    expect(TODO_STATUSES).toEqual(["pending", "in_progress", "completed"]);
    expect(todoTool.name).toBe("todoWriteTool");
    expect(
      todoWriteToolInputSchema.parse({
        items: [{ content: "Run checks", status: "pending" }],
      }),
    ).toEqual({
      items: [{ content: "Run checks", status: "pending" }],
    });
    await expect(
      todoTool.invoke(
        {} as never,
        JSON.stringify({ items: [{ content: "Run checks", status: "completed" }] }),
      ),
    ).resolves.toBe("1. [x] Run checks");
    await expect(
      todoTool.invoke({} as never, JSON.stringify({ items: [{ content: "", status: "pending" }] })),
    ).resolves.toBe("Error: TODO content is required.");
  });
});
