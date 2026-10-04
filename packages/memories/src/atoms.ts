import type { AtomicDefinition } from "@yiku/atomic-flow";
import type { MemoryClass } from "./types.js";

export const MEMORY_ATOMS = Object.freeze({
  consolidate: {
    key: "memory.consolidate",
    kind: "memory",
    label: "Consolidate",
    level: "runtime",
  },
  contextInject: {
    key: "memory.context-inject",
    kind: "memory",
    label: "Context Inject",
    level: "runtime",
  },
  extract: {
    key: "memory.extract",
    kind: "memory",
    label: "Session Extract",
    level: "runtime",
  },
  forget: {
    key: "memory.forget",
    kind: "memory",
    label: "Memory Forget",
    level: "runtime",
  },
  ftsSearch: {
    key: "memory.fts-search",
    kind: "memory",
    label: "FTS Search",
    level: "deep",
  },
  queryEmbedding: {
    key: "memory.query-embedding",
    kind: "memory",
    label: "Query Embedding",
    level: "deep",
  },
  recall: {
    key: "memory.recall",
    kind: "memory",
    label: "Memory Recall",
    level: "runtime",
  },
  rerank: {
    key: "memory.rerank",
    kind: "memory",
    label: "Memory Rerank",
    level: "deep",
  },
  search: {
    key: "memory.search",
    kind: "memory",
    label: "Memory Search",
    level: "runtime",
  },
  vectorSearch: {
    key: "memory.vector-search",
    kind: "memory",
    label: "Vector Search",
    level: "deep",
  },
  working: {
    key: "memory.working",
    kind: "memory",
    label: "Working Memory",
    level: "runtime",
  },
  workingCapture: {
    key: "memory.working-capture",
    kind: "memory",
    label: "Working Capture",
    level: "runtime",
  },
  write: {
    key: "memory.write",
    kind: "memory",
    label: "Memory Write",
    level: "runtime",
  },
  procedure: {
    key: "memory.procedure",
    kind: "memory",
    label: "Procedure Memory",
    level: "runtime",
  },
  prune: {
    key: "memory.prune",
    kind: "memory",
    label: "Memory Prune",
    level: "runtime",
  },
  scenario: {
    key: "memory.scenario",
    kind: "memory",
    label: "Scenario Memory",
    level: "runtime",
  },
  semantic: {
    key: "memory.semantic",
    kind: "memory",
    label: "Semantic Memory",
    level: "runtime",
  },
} as const satisfies Readonly<Record<string, AtomicDefinition>>);

export const MEMORY_CLASS_ATOMS = Object.freeze({
  procedure: MEMORY_ATOMS.procedure,
  scenario: MEMORY_ATOMS.scenario,
  semantic: MEMORY_ATOMS.semantic,
} as const satisfies Readonly<Record<MemoryClass, AtomicDefinition>>);

export const MEMORY_ATOM_DEFINITIONS: readonly AtomicDefinition[] = Object.freeze(
  Object.values(MEMORY_ATOMS),
);
