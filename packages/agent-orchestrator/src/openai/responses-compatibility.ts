import { type Model, OpenAIProvider, OpenAIResponsesModel } from "@openai/agents";

type OutputConverter = (items: unknown) => unknown;

interface ResponsesModelInternals {
  _convertResponseOutputItems: OutputConverter;
}

const wrappedModels = new WeakSet<object>();

export class CompatibleOpenAIProvider extends OpenAIProvider {
  public override async getModel(modelName?: string | undefined): Promise<Model> {
    return installResponsesCompatibility(await super.getModel(modelName));
  }
}

export function installResponsesCompatibility(model: Model): Model {
  if (!(model instanceof OpenAIResponsesModel) || wrappedModels.has(model)) {
    return model;
  }

  const internals = model as unknown as Model & ResponsesModelInternals;
  const convert = internals._convertResponseOutputItems;
  if (typeof convert !== "function") {
    return model;
  }

  Object.defineProperty(model, "_convertResponseOutputItems", {
    configurable: true,
    value: (items: unknown) => convert.call(model, normalizeResponseOutputItems(items)),
    writable: true,
  });
  wrappedModels.add(model);
  return model;
}

export function normalizeResponseOutputItems(items: unknown): unknown {
  if (!Array.isArray(items)) {
    return items;
  }

  let normalized: unknown[] | undefined;
  for (const [index, item] of items.entries()) {
    const record = asRecord(item);
    if (record?.type !== "reasoning" || Array.isArray(record.summary)) {
      continue;
    }
    normalized ??= [...items];
    normalized[index] = {
      ...record,
      summary: [],
    };
  }
  return normalized ?? items;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
