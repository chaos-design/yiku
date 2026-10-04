import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { FlowEdges } from "../../src/components/flow-edge.js";
import { ATOMS, EDGES } from "../../src/data/atom-layout.js";
import {
  type FlowLayout,
  FlowLayoutEngine,
  type RoutedFlowEdge,
} from "../../src/data/flow-layout.js";
import type { EdgeRuntimeView } from "../../src/state/flow-selectors.js";

describe("FlowEdges", () => {
  let layout: FlowLayout;

  beforeAll(async () => {
    layout = await new FlowLayoutEngine().layout(ATOMS, EDGES);
  }, 60_000);

  it("renders routed edges in stable visual layers", () => {
    const markup = renderToStaticMarkup(
      <FlowEdges
        edges={layout.edges}
        edgeViews={new Map()}
        height={layout.height}
        width={layout.width}
      />,
    );

    expect(markup).toContain(`viewBox="0 0 ${layout.width} ${layout.height}"`);
    expect(markup).toContain('id="edge-arrow-active"');
    expect(markup).toContain('id="edge-arrow-hover"');
    expect(markup).toContain('markerUnits="userSpaceOnUse"');
    expect(markup).toContain('class="edge-track-layer"');
    expect(markup).toContain('class="edge-line-layer"');
    expect(markup.match(/class="edge-route"/gu)).toHaveLength(EDGES.length);
    expect(markup.match(/class="edge-hit-target"/gu)).toHaveLength(EDGES.length);
    expect(markup.match(/class="edge-casing"/gu)).toHaveLength(EDGES.length);
    expect(markup.match(/class="edge-hover-overlay"/gu)).toHaveLength(EDGES.length);
    expect(markup.match(/class="edge-port edge-port-/gu)).toHaveLength(EDGES.length);
    expect(markup.indexOf('class="edge-track-layer"')).toBeLessThan(
      markup.indexOf('class="edge-line-layer"'),
    );
    expect(markup.indexOf('class="edge-hit-target"')).toBeLessThan(
      markup.indexOf('class="edge-casing"'),
    );
    expect(markup.indexOf('class="edge-casing"')).toBeLessThan(markup.indexOf('class="edge edge-'));
    expect(markup.match(/marker-end=/gu)).toHaveLength(EDGES.length * 2);
  });

  it("renders a directional beam, particles, and target pulse for the current transition", () => {
    const edge = layout.edges[0];
    expect(edge).toBeDefined();
    const view: EdgeRuntimeView = {
      active: true,
      completed: false,
      flowing: true,
      latestSequence: 2,
      selected: false,
    };
    const markup = renderToStaticMarkup(
      <FlowEdges
        edges={layout.edges}
        edgeViews={new Map(edge === undefined ? [] : [[edge.key, view]])}
        height={layout.height}
        width={layout.width}
      />,
    );

    expect(markup).toContain('class="edge-flow-beam"');
    expect(markup).toContain('pathLength="1"');
    expect(markup).toContain('class="edge-target-pulse"');
    expect(markup.match(/<animateMotion/gu)).toHaveLength(3);
  });

  it("marks trajectory flow visuals for a slower animation cadence", () => {
    const edge = layout.edges.find((candidate) => candidate.to === "trajectory.project");
    expect(edge).toBeDefined();
    const view: EdgeRuntimeView = {
      active: false,
      completed: true,
      flowing: true,
      latestSequence: 4,
      selected: false,
    };
    const markup = renderToStaticMarkup(
      <FlowEdges
        edges={layout.edges}
        edgeViews={new Map(edge === undefined ? [] : [[edge.key, view]])}
        height={layout.height}
        width={layout.width}
      />,
    );

    expect(markup).toContain("is-trajectory-flow");
    expect(markup).toContain('class="edge-flow-beam is-trajectory-flow"');
    expect(markup).toContain('class="edge-target-pulse is-trajectory-flow"');
  });

  it("applies selected and completed marker precedence independently", () => {
    const [selectedEdge, completedEdge] = layout.edges as readonly [
      RoutedFlowEdge,
      RoutedFlowEdge,
      ...RoutedFlowEdge[],
    ];
    const views = new Map<string, EdgeRuntimeView>([
      [
        selectedEdge.key,
        {
          active: true,
          completed: true,
          flowing: true,
          latestSequence: 3,
          selected: true,
        },
      ],
      [
        completedEdge.key,
        {
          active: false,
          completed: true,
          flowing: false,
          latestSequence: 2,
          selected: false,
        },
      ],
    ]);
    const markup = renderToStaticMarkup(
      <FlowEdges
        edges={[selectedEdge, completedEdge]}
        edgeViews={views}
        height={layout.height}
        width={layout.width}
      />,
    );

    expect(markup).toContain('marker-end="url(#edge-arrow-selected)"');
    expect(markup).toContain('marker-end="url(#edge-arrow-complete)"');
    expect(markup).toContain("is-active is-complete is-flowing is-selected");
  });
});
