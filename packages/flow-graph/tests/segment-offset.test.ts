import { describe, expect, it } from "vitest";
import {
  FlowGraphError,
  isOrthogonalRoute,
  offsetOrthogonalRoute,
  routeLength,
} from "../src/index.js";

describe("offsetOrthogonalRoute", () => {
  it("offsets horizontal and vertical segments in canvas coordinates", () => {
    expect(
      offsetOrthogonalRoute(
        [
          { x: 0, y: 0 },
          { x: 20, y: 0 },
        ],
        { 1: 5 },
      ),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 5 },
      { x: 20, y: 5 },
      { x: 20, y: 0 },
    ]);
    expect(
      offsetOrthogonalRoute(
        [
          { x: 0, y: 0 },
          { x: 0, y: 20 },
        ],
        { 1: -4 },
      ),
    ).toEqual([
      { x: 0, y: 0 },
      { x: -4, y: 0 },
      { x: -4, y: 20 },
      { x: 0, y: 20 },
    ]);
  });

  it("rebuilds adjacent offset segments while anchoring both endpoints", () => {
    const input = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 40, y: 20 },
    ] as const;
    const result = offsetOrthogonalRoute(input, { 1: 5, 2: 4, 3: -5 });

    expect(result).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 5 },
      { x: 24, y: 5 },
      { x: 24, y: 15 },
      { x: 40, y: 15 },
      { x: 40, y: 20 },
    ]);
    expect(result[0]).toEqual(input[0]);
    expect(result.at(-1)).toEqual(input.at(-1));
    expect(isOrthogonalRoute(result)).toBe(true);
    expect(routeLength(result)).toBe(60);
    expect(input).toEqual([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 40, y: 20 },
    ]);
  });

  it("uses sparse one-based offsets after normalizing duplicate and collinear points", () => {
    const result = offsetOrthogonalRoute(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 20 },
      ],
      { 2: 3 },
    );

    expect(result).toEqual([
      { x: 0, y: 0 },
      { x: 23, y: 0 },
      { x: 23, y: 20 },
      { x: 20, y: 20 },
    ]);
    expect(
      offsetOrthogonalRoute(
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 20, y: 0 },
        ],
        {},
      ),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
    ]);
  });

  it("rejects malformed routes, segment numbers, and offsets with stable errors", () => {
    expectInvalidOffset(() => offsetOrthogonalRoute([{ x: 0, y: 0 }], {}), "points");
    expectInvalidOffset(
      () =>
        offsetOrthogonalRoute(
          [
            { x: 0, y: 0 },
            { x: 10, y: 10 },
          ],
          {},
        ),
      "points[1]",
    );
    expectInvalidOffset(
      () =>
        offsetOrthogonalRoute(
          [
            { x: 0, y: 0 },
            { x: Number.NaN, y: 0 },
          ],
          {},
        ),
      "points[1].x",
    );
    expectInvalidOffset(
      () =>
        offsetOrthogonalRoute(
          [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
          { 2: 4 },
        ),
      "segmentOffsets.2",
    );
    expectInvalidOffset(
      () =>
        offsetOrthogonalRoute(
          [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
          { 1: Number.POSITIVE_INFINITY },
        ),
      "segmentOffsets.1",
    );
    expectInvalidOffset(
      () =>
        offsetOrthogonalRoute(
          [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
          { "01": 2 } as unknown as Readonly<Record<number, number>>,
        ),
      "segmentOffsets.01",
    );
  });
});

function expectInvalidOffset(run: () => unknown, path: string): void {
  try {
    run();
    throw new Error("Expected offsetOrthogonalRoute to throw.");
  } catch (error) {
    expect(error).toBeInstanceOf(FlowGraphError);
    expect(error).toMatchObject({
      code: "FLOW_GRAPH_INVALID_SEGMENT_OFFSET",
      path,
    });
  }
}
