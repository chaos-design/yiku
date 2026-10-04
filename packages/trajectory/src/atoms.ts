import type { AtomicDefinition } from "@yiku/atomic-flow";

export const TRAJECTORY_ATOMS = Object.freeze({
  project: {
    key: "trajectory.project",
    kind: "trajectory",
    label: "Trajectory Project",
    level: "runtime",
  },
} as const satisfies Readonly<Record<string, AtomicDefinition>>);

export const TRAJECTORY_ATOM_DEFINITIONS: readonly AtomicDefinition[] = Object.freeze(
  Object.values(TRAJECTORY_ATOMS),
);
