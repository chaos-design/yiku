import type { Trajectory, TrajectoryRenderOptions, TrajectoryStep } from "./types.js";

export function renderTrajectoryText(
  trajectory: Trajectory,
  options: TrajectoryRenderOptions = {},
): string {
  const lines = [`Trajectory ${trajectory.id}`];

  for (const step of trajectory.steps) {
    const prefix = step.parentId ? "  - " : "- ";
    lines.push(`${prefix}${formatStep(step)}`);

    if (options.includeRawValues) {
      appendRawValue(lines, "input", step.input);
      appendRawValue(lines, "output", step.output);
      appendRawValue(lines, "error", step.error);
    }
  }

  return lines.join("\n");
}

export function renderTrajectoryMarkdown(
  trajectory: Trajectory,
  options: TrajectoryRenderOptions = {},
): string {
  const lines = [
    `# Trajectory ${trajectory.id}`,
    "",
    `- Started: ${trajectory.startedAt}`,
    `- Ended: ${trajectory.endedAt ?? "running"}`,
    `- Steps: ${trajectory.steps.length}`,
    "",
    "## Steps",
    "",
  ];

  for (const [index, step] of trajectory.steps.entries()) {
    lines.push(`### ${index + 1}. ${step.kind}: ${step.name}`);
    lines.push("");
    lines.push(`- Status: ${step.status}`);
    lines.push(`- Started: ${step.startedAt}`);

    if (step.endedAt !== undefined) {
      lines.push(`- Ended: ${step.endedAt}`);
    }

    if (step.parentId !== undefined) {
      lines.push(`- Parent: ${step.parentId}`);
    }

    if (options.includeRawValues) {
      appendMarkdownValue(lines, "Input", step.input);
      appendMarkdownValue(lines, "Output", step.output);
      appendMarkdownValue(lines, "Error", step.error);
    }

    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export function renderTrajectoryMermaid(trajectory: Trajectory): string {
  const lines = ["flowchart TD"];

  if (trajectory.steps.length === 0) {
    lines.push("  empty[No steps]");
    return lines.join("\n");
  }

  for (const step of trajectory.steps) {
    lines.push(`  ${sanitizeId(step.id)}["${escapeMermaidLabel(formatStep(step))}"]`);
  }

  for (const step of trajectory.steps) {
    if (step.parentId !== undefined) {
      lines.push(`  ${sanitizeId(step.parentId)} --> ${sanitizeId(step.id)}`);
    }
  }

  return lines.join("\n");
}

function formatStep(step: TrajectoryStep): string {
  const duration = formatDuration(step);

  return duration
    ? `${step.kind}:${step.name} ${step.status} ${duration}`
    : `${step.kind}:${step.name} ${step.status}`;
}

function formatDuration(step: TrajectoryStep): string {
  if (step.endedAt === undefined) {
    return "";
  }

  const startedAtMs = Date.parse(step.startedAt);
  const endedAtMs = Date.parse(step.endedAt);

  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return "";
  }

  return `(${Math.max(0, endedAtMs - startedAtMs)}ms)`;
}

function appendRawValue(lines: string[], label: string, value: unknown): void {
  if (value === undefined) {
    return;
  }

  lines.push(`    ${label}: ${formatInlineValue(value)}`);
}

function appendMarkdownValue(lines: string[], label: string, value: unknown): void {
  if (value === undefined) {
    return;
  }

  lines.push("");
  lines.push(`${label}:`);
  lines.push("");
  lines.push("```json");
  lines.push(formatBlockValue(value));
  lines.push("```");
}

function formatInlineValue(value: unknown): string {
  return formatBlockValue(value).replace(/\s+/gu, " ").trim();
}

function formatBlockValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function sanitizeId(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_]/gu, "_");

  return /^[a-zA-Z_]/u.test(sanitized) ? sanitized : `step_${sanitized}`;
}

function escapeMermaidLabel(value: string): string {
  return value.replace(/"/gu, '\\"');
}
