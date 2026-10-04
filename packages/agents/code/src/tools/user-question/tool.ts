import { type ToolInputParameters, tool } from "@openai/agents";
import { executeTool, type ToolCallMetadata } from "../common/middleware.js";
import { formatToolError } from "../common/output.js";
import {
  normalizeUserQuestionResponse,
  parseUserQuestionInput,
  type UserQuestionRequest,
  type UserQuestionToolOptions,
} from "./types.js";

const userQuestionToolParameters = {
  additionalProperties: false,
  properties: {
    questions: {
      description: "One to four closely related questions for the user.",
      items: {
        additionalProperties: false,
        properties: {
          allowAutoRecommended: {
            description:
              "Whether a trusted non-interactive host may select the unique recommended option.",
            type: "boolean",
          },
          header: {
            description: "A concise header with at most 12 characters.",
            maxLength: 12,
            minLength: 1,
            type: "string",
          },
          multiSelect: {
            description: "Whether the user may select multiple options.",
            type: "boolean",
          },
          options: {
            description: "Two to four distinct answer options.",
            items: {
              additionalProperties: false,
              properties: {
                description: {
                  description: "A useful explanation of the option.",
                  maxLength: 500,
                  minLength: 1,
                  type: "string",
                },
                label: {
                  description: "A concise option label.",
                  maxLength: 200,
                  minLength: 1,
                  type: "string",
                },
                optionId: {
                  description: "A stable lowercase ASCII option identifier.",
                  maxLength: 100,
                  minLength: 1,
                  pattern: "^[a-z0-9]+(?:[.-][a-z0-9]+)*$",
                  type: "string",
                },
                recommended: {
                  description: "Whether this is the single recommended option.",
                  type: "boolean",
                },
              },
              required: ["description", "label", "optionId", "recommended"],
              type: "object",
            },
            maxItems: 4,
            minItems: 2,
            type: "array",
          },
          preconfiguredAnswer: {
            description:
              "Whether a trusted answers file may provide this required input non-interactively.",
            type: "boolean",
          },
          question: {
            description: "A clear question ending with a question mark.",
            maxLength: 1_000,
            minLength: 1,
            type: "string",
          },
          questionKey: {
            description: "A stable versioned key using <owner>.<namespace>.<name>@<major>.",
            maxLength: 200,
            minLength: 1,
            pattern: "^[a-z0-9]+(?:[.-][a-z0-9]+)*@[1-9][0-9]*$",
            type: "string",
          },
          risk: {
            description: "The interaction risk classification.",
            enum: ["permission", "preference", "required-input", "secret"],
            type: "string",
          },
        },
        required: [
          "allowAutoRecommended",
          "header",
          "multiSelect",
          "options",
          "preconfiguredAnswer",
          "question",
          "questionKey",
          "risk",
        ],
        type: "object",
      },
      maxItems: 4,
      minItems: 1,
      type: "array",
    },
  },
  required: ["questions"],
  type: "object",
} satisfies ToolInputParameters;

export function askUserTool(options: UserQuestionToolOptions = {}) {
  const name = options.name ?? "AskUserQuestion";

  return tool({
    description:
      options.description ??
      "Ask the user 1-4 necessary questions. Use stable versioned questionKey and optionId values, classify risk, and explicitly mark recommendations. The input must contain only the top-level questions array. Continue the same run after receiving all answers.",
    errorFunction: (_context: unknown, error: unknown) => formatToolError(error),
    execute: (input: unknown, _context?: unknown, details?: ToolCallMetadata) => {
      const request = parseUserQuestionInput(input);
      return executeTool(
        {
          ...(details?.toolCall?.callId !== undefined ? { callId: details.toolCall.callId } : {}),
          effect: "external",
          execute: async (resolved) => {
            if (options.handler === undefined) {
              throw new Error("User question handler is not configured.");
            }

            const requestWithMetadata: UserQuestionRequest = {
              ...resolved,
              ...(details?.toolCall?.callId !== undefined
                ? { toolCallId: details.toolCall.callId }
                : {}),
            };
            const response = normalizeUserQuestionResponse(
              requestWithMetadata,
              await options.handler(requestWithMetadata),
            );
            return JSON.stringify(response);
          },
          input: request,
          ...(details?.signal !== undefined ? { signal: details.signal } : {}),
          toolName: name,
          validate: parseUserQuestionInput,
        },
        options.middleware,
      );
    },
    name,
    parameters: userQuestionToolParameters,
    strict: true,
  });
}
