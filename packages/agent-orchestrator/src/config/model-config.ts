import type { ModelsConfig } from "@yiku/config";
import { inferModelContextWindow } from "./model-context-window.js";
import type {
  ContextWindowSource,
  ResolvedModelConfig,
  ResolveModelConfigOptions,
} from "./types.js";

const DEFAULT_API_KEY_ENV = "OPENAI_API_KEY";
const DEFAULT_AGENT_NAME = "Yiku Code Agent";
const ENV_FILE_LOCATIONS = "~/.yiku/.env or <workspace>/.env";
const GENERIC_API_KEY_ENV = "AI_API_KEY";

interface ModelItemConfig {
  readonly agentName?: string | undefined;
  readonly apiKeyEnv?: string | undefined;
  readonly baseURL?: string | undefined;
  readonly contextWindow?: unknown;
  readonly instructions?: string | undefined;
  readonly name?: string | undefined;
}

interface ContextWindowResolution {
  readonly source: ContextWindowSource;
  readonly value: number;
}

export function resolveModelConfig(options: ResolveModelConfigOptions): ResolvedModelConfig {
  const models = getModelsSection(options.modelsConfig);
  const selectedModelKey = firstNonEmpty(
    options.modelKey,
    options.env.AI_MODEL,
    models?.default,
    options.env.AI_MODEL_NAME,
  );

  if (!selectedModelKey) {
    throw new Error("Model is required. Provide AI_MODEL, AI_MODEL_NAME, or models.default.");
  }

  const modelItem = getModelItem(models?.items, selectedModelKey);
  const model = firstNonEmpty(options.env.AI_MODEL_NAME, modelItem?.name) ?? selectedModelKey;
  const apiKeyEnv =
    firstNonEmpty(
      options.env.AI_API_KEY_ENV,
      modelItem?.apiKeyEnv,
      options.env[GENERIC_API_KEY_ENV] ? GENERIC_API_KEY_ENV : undefined,
    ) ?? DEFAULT_API_KEY_ENV;
  const agentName =
    firstNonEmpty(options.env.AI_AGENT_NAME, modelItem?.agentName) ?? DEFAULT_AGENT_NAME;
  const baseURL = firstNonEmpty(
    options.env.AI_BASE_URL,
    options.env.OPENAI_BASE_URL,
    modelItem?.baseURL,
  );
  const instructions = firstNonEmpty(options.env.AI_INSTRUCTIONS, modelItem?.instructions);
  const contextWindow = resolveContextWindow(
    options.env.AI_CONTEXT_WINDOW,
    modelItem?.contextWindow,
    selectedModelKey,
    model,
  );
  const apiKey = options.env[apiKeyEnv]?.trim();

  if (!apiKey) {
    if (apiKeyEnv === DEFAULT_API_KEY_ENV) {
      throw new Error(
        `API key is required. Set ${DEFAULT_API_KEY_ENV} or ${GENERIC_API_KEY_ENV} in ${ENV_FILE_LOCATIONS}. API keys belong in .env files, not config.yaml.`,
      );
    }

    throw new Error(
      `API key is required. Set ${apiKeyEnv} in ${ENV_FILE_LOCATIONS}. API keys belong in .env files, not config.yaml.`,
    );
  }

  return {
    agentName,
    apiKey,
    apiKeyEnv,
    ...(baseURL ? { baseURL } : {}),
    ...(contextWindow !== undefined
      ? {
          contextWindow: contextWindow.value,
          contextWindowSource: contextWindow.source,
        }
      : {}),
    ...(instructions ? { instructions } : {}),
    model,
    modelKey: selectedModelKey,
  };
}

function getModelsSection(modelsConfig: ModelsConfig | undefined):
  | {
      readonly default?: string | undefined;
      readonly items?: Record<string, unknown> | undefined;
    }
  | undefined {
  const models = modelsConfig?.models;

  if (!isRecord(models)) {
    return undefined;
  }

  return {
    ...(typeof models.default === "string" ? { default: models.default } : {}),
    ...(isRecord(models.items) ? { items: models.items } : {}),
  };
}

function getModelItem(
  items: Record<string, unknown> | undefined,
  modelKey: string,
): ModelItemConfig | undefined {
  const item = items?.[modelKey];

  if (!isRecord(item)) {
    return undefined;
  }

  return {
    ...(typeof item.agentName === "string" ? { agentName: item.agentName } : {}),
    ...(typeof item.apiKeyEnv === "string" ? { apiKeyEnv: item.apiKeyEnv } : {}),
    ...(typeof item.baseURL === "string" ? { baseURL: item.baseURL } : {}),
    ...("contextWindow" in item ? { contextWindow: item.contextWindow } : {}),
    ...(typeof item.instructions === "string" ? { instructions: item.instructions } : {}),
    ...(typeof item.name === "string" ? { name: item.name } : {}),
  };
}

function resolveContextWindow(
  envValue: string | undefined,
  modelValue: unknown,
  modelKey: string,
  model: string,
): ContextWindowResolution | undefined {
  const trimmedEnvValue = envValue?.trim();

  if (trimmedEnvValue) {
    return {
      source: "configured",
      value: parseContextWindow(trimmedEnvValue, "AI_CONTEXT_WINDOW"),
    };
  }

  if (modelValue !== undefined) {
    return {
      source: "configured",
      value: parseContextWindow(modelValue, `models.items.${modelKey}.contextWindow`),
    };
  }

  const inferredContextWindow = inferModelContextWindow(model);
  return inferredContextWindow === undefined
    ? undefined
    : {
        source: "inferred",
        value: inferredContextWindow,
      };
}

function parseContextWindow(value: unknown, source: string): number {
  const parsedValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;

  if (!Number.isSafeInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`${source} must be a positive integer.`);
  }

  return parsedValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();

    if (trimmed) {
      return trimmed;
    }
  }

  return undefined;
}
