import { describe, expect, it } from "vitest";
import {
  compactOrthogonalPoints,
  expandRect,
  isOrthogonalRoute,
  parallelProximity,
  pointInsideRect,
  routeIntersectsRect,
  routeLength,
  segmentIntersectsRectInterior,
  segmentRelation,
  toRoundedSvgPath,
} from "../src/index.js";

describe("flow graph geometry", () => {
  it("expands rectangles and treats their boundary as an open routing lane", () => {
    const bounds = expandRect({ height: 20, width: 30, x: 10, y: 20 }, 5);

    expect(bounds).toEqual({ height: 30, width: 40, x: 5, y: 15 });
    expect(pointInsideRect({ x: 6, y: 16 }, bounds)).toBe(true);
    expect(pointInsideRect({ x: 5, y: 16 }, bounds)).toBe(false);
    expect(
      segmentIntersectsRectInterior(
        {
          from: { x: 0, y: 15 },
          to: { x: 50, y: 15 },
        },
        bounds,
      ),
    ).toBe(false);
    expect(
      segmentIntersectsRectInterior(
        {
          from: { x: 0, y: 16 },
          to: { x: 50, y: 16 },
        },
        bounds,
      ),
    ).toBe(true);
    expect(
      segmentIntersectsRectInterior(
        {
          from: { x: 5, y: 0 },
          to: { x: 5, y: 50 },
        },
        bounds,
      ),
    ).toBe(false);
    expect(
      segmentIntersectsRectInterior(
        {
          from: { x: 6, y: 0 },
          to: { x: 6, y: 50 },
        },
        bounds,
      ),
    ).toBe(true);
    expect(
      segmentIntersectsRectInterior(
        {
          from: { x: 0, y: 0 },
          to: { x: 50, y: 50 },
        },
        bounds,
      ),
    ).toBe(true);
    expect(
      segmentIntersectsRectInterior(
        {
          from: { x: -20, y: -20 },
          to: { x: -10, y: -10 },
        },
        bounds,
      ),
    ).toBe(false);
  });

  it("compacts orthogonal paths and computes stable geometry", () => {
    const points = compactOrthogonalPoints([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 15 },
    ]);

    expect(points).toEqual([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 15 },
    ]);
    expect(isOrthogonalRoute(points)).toBe(true);
    expect(routeLength(points)).toBe(35);
    expect(
      routeLength([
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ]),
    ).toBe(10);
    expect(routeIntersectsRect(points, { height: 10, width: 10, x: 5, y: -5 })).toBe(true);
    expect(toRoundedSvgPath(points, 4)).toBe("M 0 0 L 16 0 Q 20 0 20 4 L 20 15");
    expect(toRoundedSvgPath([], 4)).toBe("");
    expect(toRoundedSvgPath([{ x: 2, y: 3 }], -1)).toBe("M 2 3");
  });

  it("distinguishes crossings, overlap, and close parallel segments", () => {
    const horizontal = {
      from: { x: 0, y: 10 },
      to: { x: 50, y: 10 },
    };
    const vertical = {
      from: { x: 20, y: 0 },
      to: { x: 20, y: 30 },
    };
    const overlapping = {
      from: { x: 10, y: 10 },
      to: { x: 30, y: 10 },
    };
    const parallel = {
      from: { x: 0, y: 18 },
      to: { x: 50, y: 18 },
    };

    expect(segmentRelation(horizontal, vertical)).toEqual({ crosses: true, overlap: 0 });
    expect(segmentRelation(horizontal, overlapping)).toEqual({ crosses: false, overlap: 20 });
    expect(parallelProximity(horizontal, parallel, 16)).toBe(400);
  });
});
