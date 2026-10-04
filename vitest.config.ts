import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      all: true,
      exclude: [
        "packages/**/src/**/index.ts",
        "packages/**/src/**/index.tsx",
        "packages/**/src/**/types.ts",
        "packages/atomic-flow/src/browser.ts",
        "packages/agent-orchestrator/src/openai/tracing.ts",
        "packages/cli/src/trace.ts",
      ],
      include: ["packages/**/src/**/*.{ts,tsx}"],
      provider: "v8",
      reporter: ["text", "lcov"],
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
    include: ["packages/**/tests/**/*.test.{ts,tsx}"],
  },
});
