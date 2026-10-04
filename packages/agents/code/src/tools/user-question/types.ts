import { z } from "zod";
import type { ToolExecutionMiddleware } from "../common/middleware.js";

const MAX_QUESTION_LENGTH = 1_000;
const MAX_HEADER_LENGTH = 12;
const MAX_OPTION_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_FORM_DESCRIPTION_LENGTH = 1_000;
const MAX_FORM_TITLE_LENGTH = 200;
const MAX_OPTION_ID_LENGTH = 100;
const MAX_QUESTION_KEY_LENGTH = 200;

export const USER_QUESTION_RISKS = [
  "permission",
  "preference",
  "required-input",
  "secret",
] as const;

export type UserQuestionRisk = (typeof USER_QUESTION_RISKS)[number];

const optionIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_OPTION_ID_LENGTH)
  .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u, "Option ID must be stable lowercase ASCII.");

const questionKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_QUESTION_KEY_LENGTH)
  .regex(
    /^[a-z0-9]+(?:[.-][a-z0-9]+)*@[1-9][0-9]*$/u,
    "Question key must use <owner>.<namespace>.<name>@<major>.",
  );

const userQuestionOptionSchema = z.object({
  description: z.string().trim().min(1).max(MAX_DESCRIPTION_LENGTH),
  label: z.string().trim().min(1).max(MAX_OPTION_LENGTH),
  optionId: optionIdSchema.optional(),
  recommended: z.boolean().optional(),
});

const userQuestionFormQuestionSchema = z
  .object({
    allowAutoRecommended: z.boolean().optional(),
    header: z.string().trim().min(1).max(MAX_HEADER_LENGTH),
    multiSelect: z.boolean(),
    options: z.array(userQuestionOptionSchema).min(2).max(4),
    preconfiguredAnswer: z.boolean().optional(),
    question: z.string().trim().min(1).max(MAX_QUESTION_LENGTH),
    questionKey: questionKeySchema.optional(),
    risk: z.enum(USER_QUESTION_RISKS).optional(),
  })
  .superRefine((input, context) => {
    const labels = input.options.map((option) => option.label);
    if (new Set(labels).size !== labels.length) {
      context.addIssue({
        code: "custom",
        message: "Question option labels must be unique.",
        path: ["options"],
      });
    }
    const optionIds = input.options.flatMap((option) =>
      option.optionId === undefined ? [] : [option.optionId],
    );
    if (new Set(optionIds).size !== optionIds.length) {
      context.addIssue({
        code: "custom",
        message: "Question option IDs must be unique.",
        path: ["options"],
      });
    }
    if (input.options.filter((option) => option.recommended === true).length > 1) {
      context.addIssue({
        code: "custom",
        message: "Question options may contain at most one recommendation.",
        path: ["options"],
      });
    }
  });

export const userQuestionInputSchema = z
  .object({
    description: z.string().trim().min(1).max(MAX_FORM_DESCRIPTION_LENGTH).optional(),
    options: z.array(z.string().trim().min(1).max(MAX_OPTION_LENGTH)).min(2).max(4).optional(),
    question: z.string().trim().min(1).max(MAX_QUESTION_LENGTH).optional(),
    questions: z.array(userQuestionFormQuestionSchema).min(1).max(4).optional(),
    title: z.string().trim().min(1).max(MAX_FORM_TITLE_LENGTH).optional(),
  })
  .superRefine((input, context) => {
    const legacy = input.question !== undefined;
    const structured = input.questions !== undefined;
    if (legacy === structured) {
      context.addIssue({
        code: "custom",
        message: "Provide either question or questions, but not both.",
        path: [],
      });
    }
    if (!legacy && input.options !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Legacy options require question.",
        path: ["options"],
      });
    }
    if (input.options !== undefined && new Set(input.options).size !== input.options.length) {
      context.addIssue({
        code: "custom",
        message: "Question options must be unique.",
        path: ["options"],
      });
    }
    if (input.questions !== undefined) {
      const questionKeys = input.questions.flatMap((question) =>
        question.questionKey === undefined ? [] : [question.questionKey],
      );
      if (new Set(questionKeys).size !== questionKeys.length) {
        context.addIssue({
          code: "custom",
          message: "Question keys must be unique within a form.",
          path: ["questions"],
        });
      }
    }
  });

export interface LegacyUserQuestionInput {
  readonly options?: string[] | undefined;
  readonly question: string;
}

export interface UserQuestionFormInput {
  readonly description?: string | undefined;
  readonly questions: UserQuestionFormQuestion[];
  readonly title?: string | undefined;
}

export type UserQuestionInput = LegacyUserQuestionInput | UserQuestionFormInput;
export type UserQuestionSchemaInput = z.infer<typeof userQuestionInputSchema>;
export type UserQuestionOption = z.infer<typeof userQuestionOptionSchema>;
export type UserQuestionFormQuestion = z.infer<typeof userQuestionFormQuestionSchema>;

export type UserQuestionRequest = UserQuestionInput & {
  readonly toolCallId?: string | undefined;
};

export interface LegacyUserQuestionResponse {
  readonly answer: string;
  readonly selectedIndex?: number | undefined;
}

export interface UserQuestionFormAnswer {
  readonly answers: readonly string[];
  readonly questionIndex: number;
  readonly selectedIndexes: readonly number[];
}

export interface UserQuestionFormResponse {
  readonly answers: readonly UserQuestionFormAnswer[];
}

export type UserQuestionResponse = LegacyUserQuestionResponse | UserQuestionFormResponse;

export interface NormalizedUserQuestion {
  readonly allowAutoRecommended: boolean;
  readonly allowCustom: boolean;
  readonly freeText: boolean;
  readonly header: string;
  readonly multiSelect: boolean;
  readonly options: readonly UserQuestionOption[];
  readonly preconfiguredAnswer: boolean;
  readonly question: string;
  readonly questionKey?: string | undefined;
  readonly risk: UserQuestionRisk;
}

export interface NormalizedUserQuestionRequest {
  readonly description?: string | undefined;
  readonly questions: readonly NormalizedUserQuestion[];
  readonly source: "legacy" | "structured";
  readonly title?: string | undefined;
}

export type UserQuestionHandler = (
  request: UserQuestionRequest,
) => Promise<UserQuestionResponse> | UserQuestionResponse;

export interface UserQuestionToolOptions {
  readonly description?: string | undefined;
  readonly handler?: UserQuestionHandler | undefined;
  readonly middleware?: ToolExecutionMiddleware | undefined;
  readonly name?: string | undefined;
}

export function parseUserQuestionInput(value: unknown): UserQuestionInput {
  const record = requireRecord(value, "User question input must be an object.");
  const questions = record.questions;
  const candidate =
    Array.isArray(questions) && questions.length > 0
      ? {
          ...(record.description !== undefined ? { description: record.description } : {}),
          questions,
          ...(record.title !== undefined ? { title: record.title } : {}),
        }
      : {
          ...(record.options !== undefined ? { options: record.options } : {}),
          ...(isMeaningfulQuestion(record.question) ? { question: record.question } : {}),
        };

  return userQuestionInputSchema.parse(candidate) as UserQuestionInput;
}

export function isStructuredUserQuestionRequest(
  request: UserQuestionRequest,
): request is UserQuestionFormInput & { readonly toolCallId?: string | undefined } {
  return "questions" in request && Array.isArray(request.questions);
}

export function normalizeUserQuestionRequest(
  request: UserQuestionRequest,
): NormalizedUserQuestionRequest {
  const input = parseUserQuestionInput(request);
  if (isStructuredUserQuestionRequest(input)) {
    return deepFreeze({
      ...(input.description !== undefined ? { description: input.description } : {}),
      questions: input.questions.map((question) => ({
        allowAutoRecommended: question.allowAutoRecommended ?? false,
        allowCustom: true,
        freeText: false,
        header: question.header,
        multiSelect: question.multiSelect,
        options: question.options.map((option) => ({ ...option })),
        preconfiguredAnswer: question.preconfiguredAnswer ?? false,
        question: question.question,
        ...(question.questionKey !== undefined ? { questionKey: question.questionKey } : {}),
        risk: question.risk ?? "required-input",
      })),
      source: "structured",
      ...(input.title !== undefined ? { title: input.title } : {}),
    });
  }
  const legacy = input as LegacyUserQuestionInput;

  return deepFreeze({
    questions: [
      {
        allowAutoRecommended: false,
        allowCustom: false,
        freeText: legacy.options === undefined,
        header: "问题",
        multiSelect: false,
        options: (legacy.options ?? []).map((label) => ({
          description: "",
          label,
        })),
        preconfiguredAnswer: false,
        question: legacy.question,
        risk: "required-input",
      },
    ],
    source: "legacy",
  });
}

export function normalizeUserQuestionResponse(
  request: UserQuestionRequest,
  response: unknown,
): UserQuestionResponse {
  return isStructuredUserQuestionRequest(request)
    ? normalizeFormResponse(request, response)
    : normalizeLegacyResponse(request, response);
}

function normalizeLegacyResponse(
  request: LegacyUserQuestionInput,
  response: unknown,
): LegacyUserQuestionResponse {
  const record = requireRecord(response, "User question response must be an object.");
  const rawAnswer = record.answer;
  if (typeof rawAnswer !== "string" || !rawAnswer.trim()) {
    throw new Error("User question answer must be non-empty.");
  }
  const answer = rawAnswer.trim();
  const rawSelectedIndex = record.selectedIndex;
  if (rawSelectedIndex !== undefined && !Number.isInteger(rawSelectedIndex)) {
    throw new Error("User question selected option must be an integer.");
  }
  const selectedIndex = rawSelectedIndex as number | undefined;
  const options = request.options;
  if (options === undefined) {
    if (selectedIndex !== undefined) {
      throw new Error("Free-text answers cannot include a selected option.");
    }
    return { answer };
  }

  const resolvedIndex = selectedIndex ?? options.indexOf(answer);
  if (resolvedIndex < 0 || resolvedIndex >= options.length) {
    throw new Error("User question response must select one of the provided options.");
  }
  if (answer !== options[resolvedIndex]) {
    throw new Error("User question answer does not match the selected option.");
  }
  return {
    answer,
    selectedIndex: resolvedIndex,
  };
}

function normalizeFormResponse(
  request: UserQuestionFormInput,
  response: unknown,
): UserQuestionFormResponse {
  const record = requireRecord(response, "User question form response must be an object.");
  if (!Array.isArray(record.answers) || record.answers.length !== request.questions.length) {
    throw new Error("User question form must answer every question exactly once.");
  }

  const normalized = record.answers.map((answer) => normalizeFormAnswer(request, answer));
  const indexes = normalized.map((answer) => answer.questionIndex);
  if (new Set(indexes).size !== indexes.length) {
    throw new Error("User question form contains duplicate question answers.");
  }
  for (let index = 0; index < request.questions.length; index += 1) {
    if (!indexes.includes(index)) {
      throw new Error("User question form must answer every question exactly once.");
    }
  }

  return {
    answers: normalized.toSorted((left, right) => left.questionIndex - right.questionIndex),
  };
}

function normalizeFormAnswer(
  request: UserQuestionFormInput,
  value: unknown,
): UserQuestionFormAnswer {
  const record = requireRecord(value, "User question form answer must be an object.");
  if (!Number.isInteger(record.questionIndex)) {
    throw new Error("User question index must be an integer.");
  }
  const questionIndex = record.questionIndex as number;
  const question = request.questions[questionIndex];
  if (question === undefined) {
    throw new Error("User question index is out of range.");
  }
  if (!Array.isArray(record.answers)) {
    throw new Error("User question answers must be an array.");
  }
  const answers = record.answers.map((answer) => {
    if (typeof answer !== "string" || !answer.trim()) {
      throw new Error("User question answers must be non-empty strings.");
    }
    return answer.trim();
  });
  if (answers.length === 0 || new Set(answers).size !== answers.length) {
    throw new Error("User question answers must be non-empty and unique.");
  }
  if (!Array.isArray(record.selectedIndexes)) {
    throw new Error("User question selected indexes must be an array.");
  }
  const selectedIndexes = record.selectedIndexes.map((selectedIndex) => {
    if (!Number.isInteger(selectedIndex)) {
      throw new Error("User question selected indexes must contain integers.");
    }
    const index = selectedIndex as number;
    if (index < 0 || index >= question.options.length) {
      throw new Error("User question selected index is out of range.");
    }
    return index;
  });
  if (new Set(selectedIndexes).size !== selectedIndexes.length) {
    throw new Error("User question selected indexes must be unique.");
  }

  if (!question.multiSelect && answers.length !== 1) {
    throw new Error("Single-select questions require exactly one answer.");
  }
  if (!question.multiSelect && selectedIndexes.length > 1) {
    throw new Error("Single-select questions cannot select multiple options.");
  }

  const selectedLabels = selectedIndexes.map((index) => question.options[index]?.label ?? "");
  if (selectedLabels.some((label) => !answers.includes(label))) {
    throw new Error("User question answers do not match the selected options.");
  }
  if (answers.length - selectedIndexes.length > 1) {
    throw new Error("Each question supports at most one custom answer.");
  }

  return {
    answers,
    questionIndex,
    selectedIndexes: selectedIndexes.toSorted((left, right) => left - right),
  };
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function isMeaningfulQuestion(value: unknown): value is string {
  return typeof value === "string" && value.trim().toLowerCase() !== "null";
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
