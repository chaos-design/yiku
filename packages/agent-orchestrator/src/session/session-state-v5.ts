import { parseUserQuestionInput, type UserQuestionRequest } from "@yiku/agent-code";
import { z } from "zod";
import { sessionStateV4Schema } from "./session-state-v4.js";

export const SESSION_STATE_V5_SCHEMA_VERSION = 5;

const identifierSchema = z.string().trim().min(1).max(256);
const dateSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: "Expected an ISO date-time string.",
});

const userQuestionRequestSchema = z.unknown().transform((value, context): UserQuestionRequest => {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Pending question request must be an object.");
    }
    const record = value as Readonly<Record<string, unknown>>;
    const allowedKeys = new Set([
      "description",
      "options",
      "question",
      "questions",
      "title",
      "toolCallId",
    ]);
    const unknownKey = Object.keys(record).find((key) => !allowedKeys.has(key));
    if (unknownKey !== undefined) {
      throw new Error(`Pending question request contains unknown field: ${unknownKey}.`);
    }
    const toolCallId = record.toolCallId;
    if (
      toolCallId !== undefined &&
      (typeof toolCallId !== "string" || !toolCallId.trim() || toolCallId.length > 256)
    ) {
      throw new Error("Pending question toolCallId must be a bounded non-empty string.");
    }
    const parsed = parseUserQuestionInput(value);
    return {
      ...parsed,
      ...(typeof toolCallId === "string" ? { toolCallId: toolCallId.trim() } : {}),
    };
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : String(error),
    });
    return z.NEVER;
  }
});

const pendingQuestionRecordSchema = z
  .object({
    continuation: z
      .object({
        adapter: identifierSchema,
        strategy: z.enum(["reconstructed", "review-required"]),
      })
      .strict(),
    createdAt: dateSchema,
    questionId: identifierSchema,
    request: userQuestionRequestSchema,
    stageId: identifierSchema,
    toolCallId: identifierSchema.optional(),
  })
  .strict();

const pendingQuestionsSchema = z
  .object({
    kind: z.literal("question"),
    questions: z.array(pendingQuestionRecordSchema).min(1).max(16),
  })
  .strict()
  .superRefine((input, context) => {
    const questionIds = input.questions.map((question) => question.questionId);
    if (new Set(questionIds).size !== questionIds.length) {
      context.addIssue({
        code: "custom",
        message: "Pending question IDs must be unique.",
        path: ["questions"],
      });
    }
  });

const legacyPendingInputSchema = sessionStateV4Schema.shape.pendingInput.unwrap();

export const sessionStateV5Schema = sessionStateV4Schema
  .omit({
    pendingInput: true,
    schemaVersion: true,
  })
  .extend({
    pendingInput: z.union([legacyPendingInputSchema, pendingQuestionsSchema]).optional(),
    schemaVersion: z.literal(SESSION_STATE_V5_SCHEMA_VERSION),
  })
  .strict();

export type SessionStateV5 = z.infer<typeof sessionStateV5Schema>;
