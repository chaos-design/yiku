import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { codeTool, toOpenAIAgentTool } from "../../../src/tools/common/definition.js";
import {
  asToolExecutionError,
  codeToolErrorResult,
  ToolExecutionError,
  ToolInputValidationError,
  ToolJsonSyntaxError,
} from "../../../src/tools/common/errors.js";
import { executeTool, type ToolExecutionMiddleware } from "../../../src/tools/common/middleware.js";

describe("executeTool", () => {
  it("executes directly when middleware is absent", async () => {
    const execute = vi.fn(async (input: { value: string }) => input.value);

    await expect(
      executeTool({
        execute,
        input: { value: "original" },
        toolName: "test",
        validate: (input) => input as { value: string },
      }),
    ).resolves.toBe("original");
    expect(execute).toHaveBeenCalledWith({ value: "original" });
  });

  it("allows middleware to validate modified input before execution", async () => {
    const execute = vi.fn(async (input: { value: string }) => input.value);
    const validate = vi.fn((input: unknown) => input as { value: string });
    const middleware: ToolExecutionMiddleware = {
      run: async (request) => {
        expect(request.effect).toBe("read");
        const result = await request.execute(request.validate({ value: "modified" }));
        expect(result).toMatchObject({
          isError: false,
          llmContent: "modified",
        });
        return result;
      },
    };

    await expect(
      executeTool(
        {
          callId: "call-1",
          effect: "read",
          execute,
          input: { value: "original" },
          toolName: "test",
          validate,
        },
        middleware,
      ),
    ).resolves.toBe("modified");
    expect(validate).toHaveBeenCalledWith({ value: "modified" });
    expect(execute).toHaveBeenCalledWith({ value: "modified" });
  });

  it("preserves generic outputs through compatibility unwrapping", async () => {
    const middleware: ToolExecutionMiddleware = {
      run: (request) => request.execute(request.input),
    };

    await expect(
      executeTool(
        {
          execute: async (input: { value: string }) => ({ output: input.value }),
          input: { value: "original" },
          toolName: "test",
          validate: (input) => input as { value: string },
        },
        middleware,
      ),
    ).resolves.toEqual({ output: "original" });
  });
});

describe("codeTool", () => {
  it("keeps valid-json schema failures distinct from JSON syntax failures", async () => {
    const definition = codeTool({
      execute: async ({ count }) => ({ isError: false, llmContent: String(count) }),
      name: "sampleTool",
      parameters: z.object({ count: z.number().int().positive() }),
    });

    await expect(definition.invoke("{")).resolves.toMatchObject({
      error: { code: "TOOL_JSON_SYNTAX_ERROR" },
      isError: true,
    });
    await expect(definition.invoke('{"count":0}')).resolves.toMatchObject({
      error: {
        code: "TOOL_INPUT_VALIDATION_ERROR",
        issues: [{ path: "count" }],
      },
      isError: true,
    });
  });

  it("bounds Zod issues and formats their paths with dots", async () => {
    const definition = codeTool({
      execute: async () => ({ isError: false, llmContent: "ok" }),
      name: "sampleTool",
      parameters: z.object({
        items: z.array(z.object({ count: z.number().positive() })),
      }),
    });
    const items = Array.from({ length: 25 }, () => ({ count: 0 }));

    const result = await definition.invoke(JSON.stringify({ items }));

    expect(result.error).toMatchObject({
      code: "TOOL_INPUT_VALIDATION_ERROR",
      issues: expect.arrayContaining([expect.objectContaining({ path: "items.0.count" })]),
    });
    expect(result.error?.issues).toHaveLength(20);
  });

  it("passes validated context through middleware with the full structured result", async () => {
    const controller = new AbortController();
    const execute = vi.fn(
      async (input: { count: number }, context: { callId?: string; signal?: AbortSignal }) => ({
        display: { count: input.count, type: "sample" },
        isError: false,
        llmContent: String(input.count),
        metadata: { callId: context.callId },
      }),
    );
    const middleware: ToolExecutionMiddleware = {
      run: async (request) => {
        expect(request.callId).toBe("call-1");
        expect(request.effect).toBe("write");
        expect(request.input).toEqual({ count: 2 });
        expect(request.signal).toBe(controller.signal);

        const result = await request.execute(request.input);
        expect(result).toEqual({
          display: { count: 2, type: "sample" },
          isError: false,
          llmContent: "2",
          metadata: { callId: "call-1" },
        });
        return result;
      },
    };
    const definition = codeTool({
      approval: "ask",
      description: "Execute a sample tool.",
      effect: ({ count }) => (count > 1 ? "write" : "read"),
      execute,
      middleware,
      name: "sampleTool",
      parameters: z.object({ count: z.number().int().positive() }),
    });

    await expect(
      definition.invoke('{"count":2}', {
        callId: "call-1",
        signal: controller.signal,
      }),
    ).resolves.toEqual({
      display: { count: 2, type: "sample" },
      isError: false,
      llmContent: "2",
      metadata: { callId: "call-1" },
    });
    expect(definition.approval).toBe("ask");
    expect(execute).toHaveBeenCalledWith(
      { count: 2 },
      { callId: "call-1", signal: controller.signal },
    );
  });

  it("adapts parsed input and metadata while returning only middleware llmContent", async () => {
    const controller = new AbortController();
    const execute = vi.fn(
      async (input: { count: number }, context: { callId?: string; signal?: AbortSignal }) => ({
        display: { count: input.count, type: "sample" },
        isError: false,
        llmContent: `definition:${input.count}`,
        metadata: { callId: context.callId },
      }),
    );
    const middleware: ToolExecutionMiddleware = {
      run: async (request) => {
        expect(request.callId).toBe("adapter-call");
        expect(request.input).toEqual({ count: 3 });
        expect(request.signal).toBe(controller.signal);

        const result = await request.execute(request.input);
        expect(result).toEqual({
          display: { count: 3, type: "sample" },
          isError: false,
          llmContent: "definition:3",
          metadata: { callId: "adapter-call" },
        });
        return {
          ...result,
          llmContent: "middleware:3",
        };
      },
    };
    const definition = codeTool({
      execute,
      middleware,
      name: "sampleTool",
      parameters: z.object({ count: z.number() }).strict(),
    });
    const openAITool = toOpenAIAgentTool(definition);

    expect(openAITool.strict).toBe(true);
    await expect(
      openAITool.invoke({} as never, '{"count":3}', {
        signal: controller.signal,
        toolCall: { callId: "adapter-call" } as never,
      }),
    ).resolves.toBe("middleware:3");
    expect(execute).toHaveBeenCalledWith(
      { count: 3 },
      { callId: "adapter-call", signal: controller.signal },
    );
  });

  it("returns structured error results to the SDK as model content", async () => {
    const definition = codeTool({
      execute: async () => ({
        error: { code: "TOOL_EXECUTION_ERROR" },
        isError: true,
        llmContent: "expected failure",
      }),
      name: "sampleTool",
      parameters: z.object({}).strict(),
    });

    await expect(toOpenAIAgentTool(definition).invoke({} as never, "{}")).resolves.toBe(
      "expected failure",
    );
  });

  it("classifies failures after validation as execution errors", async () => {
    const definition = codeTool({
      execute: async () => {
        throw new Error("boom");
      },
      name: "sampleTool",
      parameters: z.object({}),
    });

    await expect(definition.invoke("{}")).resolves.toMatchObject({
      error: { code: "TOOL_EXECUTION_ERROR" },
      isError: true,
      llmContent: expect.stringContaining("boom"),
    });
  });
});

describe("structured tool errors", () => {
  it("formats empty, pathless, reused, and non-Error failures", () => {
    expect(new ToolInputValidationError([]).message).toBe("Tool input validation failed.");
    const pathless = new ToolInputValidationError([
      {
        code: "custom",
        message: "invalid",
        path: [],
      } as z.ZodIssue,
    ]);
    expect(pathless.message).toBe("Invalid tool input: invalid");
    expect(codeToolErrorResult(pathless).error).toMatchObject({
      code: "TOOL_INPUT_VALIDATION_ERROR",
      issues: [{ message: "invalid", path: "" }],
    });

    const execution = new ToolExecutionError("failed");
    expect(execution.message).toBe("Tool execution failed: failed");
    expect(asToolExecutionError(execution)).toBe(execution);
    expect(codeToolErrorResult(execution).error).toEqual({
      code: "TOOL_EXECUTION_ERROR",
    });
    expect(new ToolJsonSyntaxError("broken").message).toBe("Invalid JSON input for tool: broken");
  });
});
