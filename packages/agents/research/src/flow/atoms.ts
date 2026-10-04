import type { AtomicDefinition } from "@yiku/atomic-flow";

export const RESEARCH_ATOMS = Object.freeze({
  citationValidate: {
    key: "research.citation-validate",
    kind: "eval",
    label: "Citation Validate",
    level: "runtime",
  },
  corroborate: {
    key: "research.corroborate",
    kind: "action",
    label: "Corroborate",
    level: "runtime",
  },
  evidenceRecord: {
    key: "research.evidence-record",
    kind: "store",
    label: "Evidence Record",
    level: "runtime",
  },
  plan: {
    key: "research.plan",
    kind: "context",
    label: "Research Plan",
    level: "runtime",
  },
  query: {
    key: "research.query",
    kind: "input",
    label: "Research Query",
    level: "runtime",
  },
  report: {
    key: "research.report",
    kind: "reply",
    label: "Research Report",
    level: "runtime",
  },
  search: {
    key: "research.search",
    kind: "tool",
    label: "Web Search",
    level: "runtime",
  },
  synthesize: {
    key: "research.synthesize",
    kind: "model",
    label: "Synthesize",
    level: "runtime",
  },
} as const satisfies Readonly<Record<string, AtomicDefinition>>);

export const RESEARCH_ATOM_DEFINITIONS: readonly AtomicDefinition[] = Object.freeze(
  Object.values(RESEARCH_ATOMS),
);
