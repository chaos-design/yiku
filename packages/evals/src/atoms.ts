import type { AtomicDefinition } from "@yiku/atomic-flow";

export const EVAL_ATOMS = Object.freeze({
  attempt: {
    key: "eval.attempt",
    kind: "eval",
    label: "Eval Attempt",
    level: "runtime",
  },
  decision: {
    key: "eval.decision",
    kind: "release",
    label: "Eval Decision",
    level: "runtime",
  },
  finalOutput: {
    key: "eval.final-output",
    kind: "eval",
    label: "Final Output",
    level: "runtime",
  },
  flowIntegrity: {
    key: "eval.flow-integrity",
    kind: "eval",
    label: "Flow Integrity",
    level: "runtime",
  },
  gate: {
    key: "eval.gate",
    kind: "release",
    label: "Eval Gate",
    level: "runtime",
  },
  judge: {
    key: "eval.judge",
    kind: "eval",
    label: "LLM Judge",
    level: "runtime",
  },
  memorySafety: {
    key: "eval.memory-safety",
    kind: "eval",
    label: "Memory Safety",
    level: "runtime",
  },
  repair: {
    key: "eval.repair",
    kind: "eval",
    label: "Eval Repair",
    level: "runtime",
  },
  scorecard: {
    key: "eval.scorecard",
    kind: "eval",
    label: "Eval Scorecard",
    level: "runtime",
  },
  trigger: {
    key: "eval.trigger",
    kind: "eval",
    label: "Eval Trigger",
    level: "runtime",
  },
} as const satisfies Readonly<Record<string, AtomicDefinition>>);

export const EVAL_ATOM_DEFINITIONS: readonly AtomicDefinition[] = Object.freeze(
  Object.values(EVAL_ATOMS),
);

export function evaluatorAtom(key: string, label: string): AtomicDefinition {
  const known = EVAL_ATOM_DEFINITIONS.find((atom) => atom.key === `eval.${key}`);
  return (
    known ?? {
      key: `eval.${key}`,
      kind: "eval",
      label,
      level: "runtime",
    }
  );
}
