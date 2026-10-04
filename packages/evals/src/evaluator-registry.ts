import { EvaluationError } from "./errors.js";
import type { EvalCheckEvaluator, EvaluatorDescriptor } from "./types.js";
import { requireIdentifier } from "./validation.js";

export class EvaluatorRegistry {
  private readonly evaluators = new Map<string, EvalCheckEvaluator>();

  public constructor(evaluators: readonly EvalCheckEvaluator[] = []) {
    for (const evaluator of evaluators) {
      this.register(evaluator);
    }
  }

  public get(key: string): EvalCheckEvaluator | undefined {
    return this.evaluators.get(key);
  }

  public list(): readonly EvaluatorDescriptor[] {
    return [...this.evaluators.values()]
      .map((evaluator) => evaluator.descriptor)
      .toSorted((left, right) => left.key.localeCompare(right.key));
  }

  public register(evaluator: EvalCheckEvaluator): void {
    validateDescriptor(evaluator.descriptor);
    if (this.evaluators.has(evaluator.descriptor.key)) {
      throw new EvaluationError(
        "EVAL_PROFILE_INVALID",
        `Duplicate evaluator key: ${evaluator.descriptor.key}.`,
      );
    }
    this.evaluators.set(evaluator.descriptor.key, evaluator);
  }
}

function validateDescriptor(descriptor: EvaluatorDescriptor): void {
  requireIdentifier(descriptor.key, "Evaluator key");
  requireIdentifier(descriptor.capability, "Evaluator capability");
  requireIdentifier(descriptor.version, "Evaluator version");
  const label = descriptor.label.trim();
  if (!label || label.length > 200) {
    throw new EvaluationError(
      "EVAL_PROFILE_INVALID",
      "Evaluator label must contain between 1 and 200 characters.",
    );
  }
  if (typeof descriptor.deterministic !== "boolean") {
    throw new EvaluationError(
      "EVAL_PROFILE_INVALID",
      `Evaluator ${descriptor.key} deterministic must be a boolean.`,
    );
  }
}
