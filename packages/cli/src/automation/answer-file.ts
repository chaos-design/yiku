import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { requireSafeHookPath } from "@yiku/hooks";
import { invalidAutomationInput } from "./errors.js";

const MAX_ANSWERS_FILE_BYTES = 1024 * 1024;
const QUESTION_KEY_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*@[1-9][0-9]*$/u;
const OPTION_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const MAX_PRECONFIGURED_VALUE_LENGTH = 10_000;

export type AutomationAnswer =
  | {
      readonly optionId: string;
    }
  | {
      readonly optionIds: readonly string[];
    }
  | {
      readonly value: string;
    };

export interface TrustedQuestionManifest {
  readonly allowAutoRecommended: boolean;
  readonly multiSelect: boolean;
  readonly optionIds: readonly string[];
  readonly preconfiguredAnswer: boolean;
  readonly questionKey: string;
  readonly recommendedOptionId?: string | undefined;
  readonly risk: "preference" | "required-input";
}

export class AutomationAnswers {
  private readonly consumed = new Set<string>();

  public constructor(
    public readonly filePath: string,
    private readonly entries: ReadonlyMap<string, AutomationAnswer>,
    private readonly manifests: ReadonlyMap<string, TrustedQuestionManifest> = new Map(),
  ) {}

  public consume(questionKey: string): AutomationAnswer | undefined {
    const answer = this.entries.get(questionKey);
    if (answer !== undefined) {
      this.consumed.add(questionKey);
    }
    return answer;
  }

  public unusedQuestionKeys(): readonly string[] {
    return Object.freeze(
      [...this.entries.keys()].filter((key) => !this.consumed.has(key)).toSorted(),
    );
  }

  public manifest(questionKey: string): TrustedQuestionManifest | undefined {
    return this.manifests.get(questionKey);
  }
}

export async function loadAutomationAnswers(filePath: string): Promise<AutomationAnswers> {
  const resolvedPath = resolve(filePath);
  let inspection: Awaited<ReturnType<typeof requireSafeHookPath>>;
  try {
    inspection = await requireSafeHookPath(resolvedPath);
  } catch {
    throw invalidAutomationInput(`Answers file path is not trusted: ${resolvedPath}.`);
  }

  const handle = await open(resolvedPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let source: string;
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== inspection.device ||
      opened.ino !== inspection.inode ||
      opened.uid !== inspection.ownerId ||
      (opened.mode & 0o077) !== 0
    ) {
      throw invalidAutomationInput("Answers file changed during secure open.");
    }
    if (opened.size > MAX_ANSWERS_FILE_BYTES) {
      throw invalidAutomationInput(`Answers file exceeds ${MAX_ANSWERS_FILE_BYTES} bytes.`);
    }
    source = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }

  rejectDuplicateQuestionKeys(source);

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw invalidAutomationInput(`Unable to parse answers file: ${resolvedPath}.`);
  }

  const document = requireRecord(value, "Answers file");
  assertOnlyKeys(document, ["answers", "manifests", "schemaVersion"], "Answers file");
  if (document.schemaVersion !== 1) {
    throw invalidAutomationInput("Answers file schemaVersion must be 1.");
  }
  const manifests = parseManifests(document.manifests);
  const rawAnswers = requireRecord(document.answers, "answers");
  const entries = new Map<string, AutomationAnswer>();

  for (const [questionKey, rawAnswer] of Object.entries(rawAnswers)) {
    if (!QUESTION_KEY_PATTERN.test(questionKey)) {
      throw invalidAutomationInput(`Invalid answer question key: ${questionKey || "(empty)"}.`);
    }
    const manifest = manifests.get(questionKey);
    if (manifest === undefined) {
      throw invalidAutomationInput(`Answer has no trusted manifest: ${questionKey}.`);
    }
    const answer = parseAnswer(rawAnswer, questionKey);
    validateManifestAnswer(manifest, answer);
    entries.set(questionKey, answer);
  }

  return new AutomationAnswers(resolvedPath, entries, manifests);
}

function parseManifests(value: unknown): ReadonlyMap<string, TrustedQuestionManifest> {
  if (!Array.isArray(value)) {
    throw invalidAutomationInput("Answers file manifests must be an array.");
  }
  const manifests = new Map<string, TrustedQuestionManifest>();
  for (const [index, item] of value.entries()) {
    const path = `manifests.${index}`;
    const manifest = requireRecord(item, path);
    assertOnlyKeys(
      manifest,
      [
        "allowAutoRecommended",
        "multiSelect",
        "optionIds",
        "preconfiguredAnswer",
        "questionKey",
        "recommendedOptionId",
        "risk",
      ],
      path,
    );
    const questionKey = requireQuestionKey(manifest.questionKey, `${path}.questionKey`);
    if (manifests.has(questionKey)) {
      throw invalidAutomationInput(`Answers file contains duplicate manifest: ${questionKey}.`);
    }
    const optionIds = requireOptionIds(manifest.optionIds, `${path}.optionIds`);
    const risk = manifest.risk;
    if (risk !== "preference" && risk !== "required-input") {
      throw invalidAutomationInput(`${path}.risk must be preference or required-input.`);
    }
    const allowAutoRecommended = requireBoolean(
      manifest.allowAutoRecommended,
      `${path}.allowAutoRecommended`,
    );
    const preconfiguredAnswer = requireBoolean(
      manifest.preconfiguredAnswer,
      `${path}.preconfiguredAnswer`,
    );
    const multiSelect = requireBoolean(manifest.multiSelect, `${path}.multiSelect`);
    const recommendedOptionId =
      manifest.recommendedOptionId === undefined
        ? undefined
        : requireOptionId(manifest.recommendedOptionId, `${path}.recommendedOptionId`);
    if (recommendedOptionId !== undefined && !optionIds.includes(recommendedOptionId)) {
      throw invalidAutomationInput(`${path}.recommendedOptionId must be declared in optionIds.`);
    }
    if (allowAutoRecommended && (risk !== "preference" || recommendedOptionId === undefined)) {
      throw invalidAutomationInput(
        `${path} automatic recommendation requires preference risk and recommendedOptionId.`,
      );
    }
    manifests.set(
      questionKey,
      Object.freeze({
        allowAutoRecommended,
        multiSelect,
        optionIds,
        preconfiguredAnswer,
        questionKey,
        ...(recommendedOptionId === undefined ? {} : { recommendedOptionId }),
        risk,
      }),
    );
  }
  return manifests;
}

function parseAnswer(value: unknown, questionKey: string): AutomationAnswer {
  const answer = requireRecord(value, `answers.${questionKey}`);
  assertOnlyKeys(answer, ["optionId", "optionIds", "value"], `answers.${questionKey}`);
  const variants = ["optionId", "optionIds", "value"].filter((key) => answer[key] !== undefined);
  if (variants.length !== 1) {
    throw invalidAutomationInput(
      `answers.${questionKey} must provide exactly one of optionId, optionIds, or value.`,
    );
  }

  if (answer.optionId !== undefined) {
    return { optionId: requireOptionId(answer.optionId, `answers.${questionKey}.optionId`) };
  }
  if (answer.optionIds !== undefined) {
    if (!Array.isArray(answer.optionIds) || answer.optionIds.length === 0) {
      throw invalidAutomationInput(`answers.${questionKey}.optionIds must be a non-empty array.`);
    }
    const optionIds = answer.optionIds.map((optionId, index) =>
      requireOptionId(optionId, `answers.${questionKey}.optionIds.${index}`),
    );
    if (new Set(optionIds).size !== optionIds.length) {
      throw invalidAutomationInput(`answers.${questionKey}.optionIds must be unique.`);
    }
    return { optionIds: Object.freeze(optionIds) };
  }

  if (typeof answer.value !== "string" || !answer.value.trim()) {
    throw invalidAutomationInput(`answers.${questionKey}.value must be a non-empty string.`);
  }
  const normalized = answer.value.trim();
  if (normalized.length > MAX_PRECONFIGURED_VALUE_LENGTH) {
    throw invalidAutomationInput(
      `answers.${questionKey}.value exceeds ${MAX_PRECONFIGURED_VALUE_LENGTH} characters.`,
    );
  }
  return { value: normalized };
}

function requireOptionId(value: unknown, path: string): string {
  if (typeof value !== "string" || !OPTION_ID_PATTERN.test(value)) {
    throw invalidAutomationInput(`${path} must be a stable lowercase ASCII option ID.`);
  }
  return value;
}

function requireOptionIds(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.length < 2) {
    throw invalidAutomationInput(`${path} must contain at least two option IDs.`);
  }
  const optionIds = value.map((item, index) => requireOptionId(item, `${path}.${index}`));
  if (new Set(optionIds).size !== optionIds.length) {
    throw invalidAutomationInput(`${path} must contain unique option IDs.`);
  }
  return Object.freeze(optionIds);
}

function requireQuestionKey(value: unknown, path: string): string {
  if (typeof value !== "string" || !QUESTION_KEY_PATTERN.test(value)) {
    throw invalidAutomationInput(`${path} must be a stable versioned question key.`);
  }
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw invalidAutomationInput(`${path} must be a boolean.`);
  }
  return value;
}

function validateManifestAnswer(manifest: TrustedQuestionManifest, answer: AutomationAnswer): void {
  if (manifest.risk === "required-input" && !manifest.preconfiguredAnswer) {
    throw invalidAutomationInput(
      `Manifest does not permit a preconfigured answer: ${manifest.questionKey}.`,
    );
  }
  if ("value" in answer) {
    if (!manifest.preconfiguredAnswer) {
      throw invalidAutomationInput(
        `Manifest does not permit a text answer: ${manifest.questionKey}.`,
      );
    }
    return;
  }
  const selected = "optionId" in answer ? [answer.optionId] : answer.optionIds;
  if (!manifest.multiSelect && selected.length !== 1) {
    throw invalidAutomationInput(`Manifest requires exactly one option: ${manifest.questionKey}.`);
  }
  if (selected.some((optionId) => !manifest.optionIds.includes(optionId))) {
    throw invalidAutomationInput(
      `Answer contains an option outside its manifest: ${manifest.questionKey}.`,
    );
  }
}

function rejectDuplicateQuestionKeys(source: string): void {
  const matches = source.matchAll(/"([a-z0-9]+(?:[.-][a-z0-9]+)*@[1-9][0-9]*)"\s*:/gu);
  const seen = new Set<string>();
  for (const match of matches) {
    const questionKey = match[1];
    if (questionKey !== undefined && seen.has(questionKey)) {
      throw invalidAutomationInput(`Answers file contains duplicate key: ${questionKey}.`);
    }
    if (questionKey !== undefined) {
      seen.add(questionKey);
    }
  }
}

function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  path: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    throw invalidAutomationInput(`${path} contains unknown field: ${unknown}.`);
  }
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidAutomationInput(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}
