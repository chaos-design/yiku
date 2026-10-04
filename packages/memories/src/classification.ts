import type { MemoryClass, MemoryKind } from "./types.js";

export const MEMORY_CLASS_ORDER = Object.freeze([
  "scenario",
  "procedure",
  "semantic",
] as const satisfies readonly MemoryClass[]);

export function memoryClassForKind(kind: MemoryKind): MemoryClass {
  switch (kind) {
    case "decision":
    case "episode":
      return "scenario";
    case "procedure":
      return "procedure";
    case "fact":
    case "preference":
      return "semantic";
  }
}

export function countMemoryClasses(
  kinds: readonly MemoryKind[],
): Readonly<Record<MemoryClass, number>> {
  const counts: Record<MemoryClass, number> = {
    procedure: 0,
    scenario: 0,
    semantic: 0,
  };
  for (const kind of kinds) {
    counts[memoryClassForKind(kind)] += 1;
  }
  return counts;
}
