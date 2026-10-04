import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunHistory, runHistoryContent } from "../../src/components/run-history.js";
import type { RunSummary } from "../../src/types.js";

describe("RunHistory", () => {
  it("builds the exact ordered content shared by rows and tooltips", () => {
    const content = runHistoryContent({
      ...run("run-987654321", "session-1"),
      createdAt: "2026-08-04T08:30:07",
      kind: "control",
      prompt: "A complete prompt",
    });

    expect(content).toEqual({
      agentTags: [
        { label: "Agent Name", value: "Code Agent" },
        { label: "Type", value: "code" },
        { label: "Session", value: "session-1" },
      ],
      metadata: ["2026-08-04 08:30:07 · CONTROL", "workspace · run-98765432 · 12 events"],
      prompt: "A complete prompt",
    });

    const { projectName: _projectName, ...sourceRun } = run("short", "session-2");
    expect(runHistoryContent(sourceRun).metadata[1]).toBe("external · short · 12 events");
  });

  it("shows distinct runs and preserves the pending selection", () => {
    const markup = renderToStaticMarkup(
      <RunHistory
        onSelect={() => undefined}
        runs={[
          { ...run("run-987654321", "session-1"), kind: "control" },
          {
            ...run("run-123456789", "session-1"),
            agentSessions: [
              {
                agentId: "child-1",
                agentName: "Reviewer",
                agentSessionId: "session-1.agent.child-1",
                agentType: "code",
                parentSessionId: "session-1",
                status: "succeeded",
                taskId: "task-1",
              },
            ],
          },
        ]}
        selectedAgentId="child-1"
        selectedRunId="run-123456789"
      />,
    );

    expect(markup).toContain("2 runs");
    expect(markup).toContain("1 subagents");
    expect(markup.match(/<button/gu)).toHaveLength(3);
    expect(markup).toContain("run-98765432");
    expect(markup).toContain("run-12345678");
    expect(markup).toContain("CONTROL");
    expect(markup).toContain("Reviewer");
    expect(markup).toContain("is-selected is-child");
    expect(markup.match(/class="run-history-meta-row/gu)).toHaveLength(7);
    expect(markup.match(/class="run-history-agent-tag"/gu)).toHaveLength(9);
    expect(markup).toContain("Agent Name");
    expect(markup).toContain("Type");
    expect(markup).toContain("Session");
    expect(markup).not.toContain('title="Prompt');
  });

  it("renders every status family, short IDs and invalid timestamps", () => {
    const statuses: readonly RunSummary["status"][] = [
      "accepted",
      "failed",
      "rejected",
      "cancelled",
      "running",
      "evaluating",
      "queued",
      "degraded",
      "needs-review",
    ];
    const markup = renderToStaticMarkup(
      <RunHistory
        onSelect={() => undefined}
        runs={statuses.map((status, index) => {
          const { projectName: _projectName, ...value } = run(
            index === 0 ? "short" : `run-${status}-long`,
            "session",
          );
          return {
            ...value,
            createdAt: index === 0 ? "invalid" : "2026-08-04T08:30:00.000Z",
            status,
          };
        })}
      />,
    );

    expect(markup).toContain("--:--");
    expect(markup).toContain("short");
    expect(markup).toContain("status-success");
    expect(markup).toContain("status-failure");
    expect(markup).toContain("status-running");
    expect(markup).toContain("external");
  });

  it("formats run timestamps with a stable local date and time layout", () => {
    const markup = renderToStaticMarkup(
      <RunHistory
        onSelect={() => undefined}
        runs={[{ ...run("run-1", "session-1"), createdAt: "2026-08-04T08:30:07" }]}
      />,
    );

    expect(markup).toContain("2026-08-04 08:30:07");
  });
});

function run(runId: string, sessionId: string): RunSummary {
  return {
    agentKey: "code",
    agentName: "Code Agent",
    agentType: "code",
    createdAt: "2026-08-04T08:30:00.000Z",
    evalMode: "blocking",
    eventCount: 12,
    projectName: "workspace",
    prompt: "Prompt",
    runId,
    sessionId,
    source: "external",
    status: "completed",
    updatedAt: "2026-08-04T08:31:00.000Z",
  };
}
