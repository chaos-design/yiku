interface ModelContextWindowRule {
  readonly contextWindow: number;
  readonly pattern: RegExp;
}

const MODEL_CONTEXT_WINDOW_RULES: readonly ModelContextWindowRule[] = [
  {
    contextWindow: 400_000,
    pattern: /^gpt-5\.4-(?:mini|nano)(?:-|$)/u,
  },
  {
    contextWindow: 1_050_000,
    pattern: /^gpt-5\.(?:4|5|6)(?:-|$)/u,
  },
  {
    contextWindow: 400_000,
    pattern: /^gpt-5(?:\.[123])?(?:-|$)/u,
  },
  {
    contextWindow: 1_047_576,
    pattern: /^gpt-4\.1(?:-|$)/u,
  },
  {
    contextWindow: 128_000,
    pattern: /^gpt-4o(?:-|$)/u,
  },
  {
    contextWindow: 200_000,
    pattern: /^(?:o3|o4-mini)(?:-|$)/u,
  },
];

export function inferModelContextWindow(model: string): number | undefined {
  const normalizedModel = model.trim().toLowerCase().split("/").at(-1);
  if (!normalizedModel) {
    return undefined;
  }

  return MODEL_CONTEXT_WINDOW_RULES.find((rule) => rule.pattern.test(normalizedModel))
    ?.contextWindow;
}
