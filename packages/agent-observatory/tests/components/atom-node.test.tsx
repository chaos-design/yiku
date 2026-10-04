import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AtomNode } from "../../src/components/atom-node.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import type { AtomLayout } from "../../src/data/atom-layout.js";
import type { AtomRuntimeView } from "../../src/state/flow-selectors.js";

describe("AtomNode", () => {
  it.each([
    ["user", "USER"],
    ["test", "TEST"],
  ] as const)("renders the %s concern marker", (focus, label) => {
    const markup = renderAtom(atom(focus));

    expect(markup).toContain(`data-focus="${focus}"`);
    expect(markup).toContain('class="atom-count"');
    expect(markup).toContain(`width:${atom(focus).width}px`);
    expect(markup).toContain(`title="${focus} concern"`);
    expect(markup).toContain(`>${label}</span>`);
  });

  it("renders observation and execution activity independently from selection", () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <AtomNode
          atom={atom("test")}
          executionActive
          observed
          onSelect={vi.fn()}
          selected={false}
        />
      </TooltipProvider>,
    );

    expect(markup).toContain("is-observed");
    expect(markup).toContain("is-execution-active");
    expect(markup).not.toContain("is-selected");
  });

  it("renders deep selected runtime state and only selects observed instances", () => {
    const deepAtom = { ...atom("user"), level: "deep" as const };
    const onSelect = vi.fn();
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <AtomNode
          atom={deepAtom}
          executionActive={false}
          observed={false}
          onSelect={onSelect}
          selected
          view={{
            count: 2,
            latest: {
              iteration: 3,
              lastSequence: 7,
              status: "completed",
            } as never,
          }}
        />
      </TooltipProvider>,
    );

    expect(markup).toContain("status-completed");
    expect(markup).toContain("is-selected");
    expect(markup).toContain("is-deep");
    expect(markup).toContain("turn 3");
    expect(markup).toContain("×2");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it.each([
    {
      atom: {
        ...atom("user"),
        domain: "capabilities" as const,
        key: "skill.execute",
        kind: "skill" as const,
        label: "Skill Execute",
      },
      expectedLabel: "code-review",
      expectedType: "skill",
      values: { name: "code-review" },
    },
    {
      atom: {
        ...atom("user"),
        key: "tool.call",
        kind: "tool" as const,
        label: "Tool Call",
      },
      expectedLabel: "filesystem/read_file",
      expectedType: "mcp",
      values: { toolName: "mcp__filesystem__read_file" },
    },
  ])(
    "renders the concrete $expectedType invocation on its atom",
    ({ atom: layout, expectedLabel, expectedType, values }) => {
      const markup = renderToStaticMarkup(
        <TooltipProvider>
          <AtomNode
            atom={layout}
            executionActive={false}
            observed
            onSelect={vi.fn()}
            selected={false}
            view={runtimeView(layout, values)}
          />
        </TooltipProvider>,
      );

      expect(markup).toContain(`data-invocation="${expectedType}"`);
      expect(markup).toContain(`atom-invocation-${expectedType}`);
      expect(markup).toContain(expectedType.toUpperCase());
      expect(markup).toContain(expectedLabel);
    },
  );
});

function renderAtom(layout: AtomLayout): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <AtomNode
        atom={layout}
        executionActive={false}
        observed={false}
        onSelect={vi.fn()}
        selected={false}
      />
    </TooltipProvider>,
  );
}

function atom(focus: AtomLayout["focus"]): AtomLayout {
  return {
    domain: focus === "test" ? "quality" : "execution",
    focus,
    key: `${focus}.atom`,
    kind: focus === "test" ? "eval" : "loop",
    label: `${focus} atom`,
    level: "runtime",
    width: 118,
    x: 0,
    y: 0,
  };
}

function runtimeView(
  layout: AtomLayout,
  values: Readonly<Record<string, string>>,
): AtomRuntimeView {
  return {
    count: 1,
    latest: {
      atom: layout,
      id: "instance-1",
      lastSequence: 1,
      status: "completed",
    },
    latestEvent: {
      atom: layout,
      eventId: "event-1",
      instance: { id: "instance-1" },
      occurredAt: "2026-08-12T00:00:00.000Z",
      payload: { values },
      phase: "end",
      runId: "run-1",
      sequence: 1,
    },
  };
}
