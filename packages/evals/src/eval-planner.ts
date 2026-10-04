import { canonicalStringify, sha256Digest } from "./canonical.js";
import { EvaluationError } from "./errors.js";
import type { EvaluatorRegistry } from "./evaluator-registry.js";
import type {
  EvalCheckDefinition,
  EvalCheckSource,
  EvalPlan,
  EvalPlanInput,
  EvalProfile,
  PlannedEvalCheck,
} from "./types.js";
import { requireIdentifier, validateEvalPlan, validateEvalProfile } from "./validation.js";

export interface EvalPlannerOptions {
  readonly clock?: (() => Date) | undefined;
  readonly registry: EvaluatorRegistry;
}

interface CheckLayer {
  readonly checks: readonly EvalCheckDefinition[];
  readonly source: EvalCheckSource;
}

export class EvalPlanner {
  private readonly clock: () => Date;
  private readonly registry: EvaluatorRegistry;

  public constructor(options: EvalPlannerOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.registry = options.registry;
  }

  public createPlan(input: EvalPlanInput): EvalPlan {
    validateEvalProfile(input.profile);
    if (input.managedProfile !== undefined) {
      validateEvalProfile(input.managedProfile);
    }
    const runId = requireIdentifier(input.runId, "Evaluation run ID");
    const taskId = requireIdentifier(input.taskId, "Evaluation task ID");
    const policy = input.managedProfile ?? input.profile;
    const layers: CheckLayer[] = [
      ...(input.managedProfile !== undefined
        ? [{ checks: input.managedProfile.checks, source: "managed" as const }]
        : []),
      {
        checks: input.profile.checks,
        source: "project",
      },
      {
        checks: input.userAcceptanceChecks ?? [],
        source: "user-acceptance",
      },
      {
        checks: input.agentFactoryChecks ?? [],
        source: "agent-factory",
      },
      {
        checks: input.agentSuggestedChecks ?? [],
        source: "agent-suggestion",
      },
    ];
    const checks = mergeChecks(layers);
    const resolvedProfile: EvalProfile = {
      checks,
      dimensionWeights: policy.dimensionWeights,
      id: policy.id,
      limits: policy.limits,
      mode: policy.mode,
      qualityThreshold: policy.qualityThreshold,
      version: 1,
    };
    validateEvalProfile(resolvedProfile);
    this.validateCapabilities(resolvedProfile);

    const createdAt = this.clock().toISOString();
    if (Number.isNaN(Date.parse(createdAt))) {
      throw new EvaluationError(
        "EVAL_PLAN_UNSATISFIABLE",
        "Evaluation planner clock returned an invalid date.",
      );
    }
    const planWithoutDigest = {
      attemptBudget: (policy.limits.maxRepairAttempts + 1) as 1 | 2,
      checks,
      createdAt,
      dimensionWeights: policy.dimensionWeights,
      limits: policy.limits,
      mode: policy.mode,
      profileId: policy.id,
      qualityThreshold: policy.qualityThreshold,
      runId,
      taskId,
      version: 1 as const,
    };
    const plan: EvalPlan = {
      ...planWithoutDigest,
      digest: sha256Digest(planWithoutDigest, {
        code: "EVAL_PLAN_UNSATISFIABLE",
        label: "Evaluation plan",
      }),
    };
    validateEvalPlan(plan);
    return freezePlan(plan);
  }

  private validateCapabilities(profile: EvalProfile): void {
    for (const check of profile.checks) {
      const evaluator = this.registry.get(check.evaluator);
      if (evaluator === undefined) {
        if (profile.mode === "enforce" && check.required) {
          throw new EvaluationError(
            "EVAL_PLAN_UNSATISFIABLE",
            `Required evaluator is unavailable: ${check.evaluator}.`,
          );
        }
        continue;
      }
      if (evaluator.descriptor.capability !== check.capability) {
        throw new EvaluationError(
          "EVAL_PLAN_UNSATISFIABLE",
          `Evaluator ${check.evaluator} provides capability ${evaluator.descriptor.capability}, not ${check.capability}.`,
        );
      }
    }
  }
}

function mergeChecks(layers: readonly CheckLayer[]): readonly PlannedEvalCheck[] {
  const merged = new Map<string, PlannedEvalCheck>();
  for (const layer of layers) {
    for (const check of layer.checks) {
      const normalized = cloneCheck(check, layer.source, merged.size);
      const existing = merged.get(normalized.id);
      if (existing === undefined) {
        merged.set(normalized.id, normalized);
        continue;
      }
      if (!sameDefinition(existing, normalized)) {
        throw new EvaluationError(
          "EVAL_PLAN_UNSATISFIABLE",
          `Lower-priority source ${layer.source} attempted to redefine evaluation check ${check.id}.`,
        );
      }
    }
  }
  return Object.freeze([...merged.values()]);
}

function cloneCheck(
  check: EvalCheckDefinition,
  source: EvalCheckSource,
  ordinal: number,
): PlannedEvalCheck {
  const config = JSON.parse(
    canonicalStringify(check.config, {
      code: "EVAL_PROFILE_INVALID",
      label: `Evaluation check ${check.id} config`,
    }),
  ) as Readonly<Record<string, unknown>>;
  return Object.freeze({
    ...check,
    config: Object.freeze(config),
    dependsOn: Object.freeze([...check.dependsOn]),
    ordinal,
    source,
  });
}

function sameDefinition(left: PlannedEvalCheck, right: PlannedEvalCheck): boolean {
  return canonicalStringify(checkDefinition(left)) === canonicalStringify(checkDefinition(right));
}

function checkDefinition(check: PlannedEvalCheck): EvalCheckDefinition {
  return {
    capability: check.capability,
    ...(check.concurrencyGroup !== undefined ? { concurrencyGroup: check.concurrencyGroup } : {}),
    config: check.config,
    dependsOn: check.dependsOn,
    dimension: check.dimension,
    evaluator: check.evaluator,
    evidenceRequired: check.evidenceRequired,
    id: check.id,
    required: check.required,
    severity: check.severity,
    timeoutMs: check.timeoutMs,
    weight: check.weight,
  };
}

function freezePlan(plan: EvalPlan): EvalPlan {
  return Object.freeze({
    ...plan,
    checks: Object.freeze([...plan.checks]),
    dimensionWeights: Object.freeze({ ...plan.dimensionWeights }),
    limits: Object.freeze({ ...plan.limits }),
  });
}
