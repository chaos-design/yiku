import type { GraphPoint, GraphRect } from "./types.js";

const EPSILON = 1e-7;

export interface GraphSegment {
  readonly from: GraphPoint;
  readonly to: GraphPoint;
}

export interface SegmentRelation {
  readonly crosses: boolean;
  readonly overlap: number;
}

export function expandRect(rect: GraphRect, padding: number): GraphRect {
  return {
    height: rect.height + padding * 2,
    width: rect.width + padding * 2,
    x: rect.x - padding,
    y: rect.y - padding,
  };
}

export function rectBottom(rect: GraphRect): number {
  return rect.y + rect.height;
}

export function rectRight(rect: GraphRect): number {
  return rect.x + rect.width;
}

export function pointInsideRect(point: GraphPoint, rect: GraphRect): boolean {
  return (
    point.x > rect.x + EPSILON &&
    point.x < rectRight(rect) - EPSILON &&
    point.y > rect.y + EPSILON &&
    point.y < rectBottom(rect) - EPSILON
  );
}

export function isOrthogonalSegment(segment: GraphSegment): boolean {
  return almostEqual(segment.from.x, segment.to.x) || almostEqual(segment.from.y, segment.to.y);
}

export function segmentIntersectsRectInterior(segment: GraphSegment, rect: GraphRect): boolean {
  if (almostEqual(segment.from.y, segment.to.y)) {
    const y = segment.from.y;
    if (y <= rect.y + EPSILON || y >= rectBottom(rect) - EPSILON) {
      return false;
    }
    return intervalsOverlapInterior(segment.from.x, segment.to.x, rect.x, rectRight(rect));
  }
  if (almostEqual(segment.from.x, segment.to.x)) {
    const x = segment.from.x;
    if (x <= rect.x + EPSILON || x >= rectRight(rect) - EPSILON) {
      return false;
    }
    return intervalsOverlapInterior(segment.from.y, segment.to.y, rect.y, rectBottom(rect));
  }

  const minimumX = Math.min(segment.from.x, segment.to.x);
  const maximumX = Math.max(segment.from.x, segment.to.x);
  const minimumY = Math.min(segment.from.y, segment.to.y);
  const maximumY = Math.max(segment.from.y, segment.to.y);
  return (
    maximumX > rect.x + EPSILON &&
    minimumX < rectRight(rect) - EPSILON &&
    maximumY > rect.y + EPSILON &&
    minimumY < rectBottom(rect) - EPSILON
  );
}

export function routeIntersectsRect(points: readonly GraphPoint[], rect: GraphRect): boolean {
  return toSegments(points).some((segment) => segmentIntersectsRectInterior(segment, rect));
}

export function compactOrthogonalPoints(input: readonly GraphPoint[]): readonly GraphPoint[] {
  const unique: GraphPoint[] = [];
  for (const point of input) {
    const previous = unique.at(-1);
    if (previous === undefined || !pointsEqual(previous, point)) {
      unique.push(point);
    }
  }

  const compacted: GraphPoint[] = [];
  for (const point of unique) {
    const previous = compacted.at(-1);
    const beforePrevious = compacted.at(-2);
    if (
      previous !== undefined &&
      beforePrevious !== undefined &&
      ((almostEqual(beforePrevious.x, previous.x) && almostEqual(previous.x, point.x)) ||
        (almostEqual(beforePrevious.y, previous.y) && almostEqual(previous.y, point.y)))
    ) {
      compacted[compacted.length - 1] = point;
    } else {
      compacted.push(point);
    }
  }
  return compacted;
}

export function isOrthogonalRoute(points: readonly GraphPoint[]): boolean {
  return toSegments(points).every(isOrthogonalSegment);
}

export function routeLength(points: readonly GraphPoint[]): number {
  return toSegments(points).reduce(
    (total, segment) =>
      total + Math.abs(segment.to.x - segment.from.x) + Math.abs(segment.to.y - segment.from.y),
    0,
  );
}

export function toSegments(points: readonly GraphPoint[]): readonly GraphSegment[] {
  const segments: GraphSegment[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    if (from !== undefined && to !== undefined && !pointsEqual(from, to)) {
      segments.push({ from, to });
    }
  }
  return segments;
}

export function segmentRelation(left: GraphSegment, right: GraphSegment): SegmentRelation {
  const leftHorizontal = almostEqual(left.from.y, left.to.y);
  const rightHorizontal = almostEqual(right.from.y, right.to.y);

  if (leftHorizontal === rightHorizontal) {
    const sameLane = leftHorizontal
      ? almostEqual(left.from.y, right.from.y)
      : almostEqual(left.from.x, right.from.x);
    if (!sameLane) {
      return { crosses: false, overlap: 0 };
    }
    const [leftStart, leftEnd] = segmentProjection(left, leftHorizontal);
    const [rightStart, rightEnd] = segmentProjection(right, rightHorizontal);
    return {
      crosses: false,
      overlap: Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart)),
    };
  }

  const horizontal = leftHorizontal ? left : right;
  const vertical = leftHorizontal ? right : left;
  const crossingX = vertical.from.x;
  const crossingY = horizontal.from.y;
  return {
    crosses:
      crossingX > Math.min(horizontal.from.x, horizontal.to.x) + EPSILON &&
      crossingX < Math.max(horizontal.from.x, horizontal.to.x) - EPSILON &&
      crossingY > Math.min(vertical.from.y, vertical.to.y) + EPSILON &&
      crossingY < Math.max(vertical.from.y, vertical.to.y) - EPSILON,
    overlap: 0,
  };
}

export function parallelProximity(
  left: GraphSegment,
  right: GraphSegment,
  parallelGap: number,
): number {
  const leftHorizontal = almostEqual(left.from.y, left.to.y);
  const rightHorizontal = almostEqual(right.from.y, right.to.y);
  if (leftHorizontal !== rightHorizontal) {
    return 0;
  }

  const distance = leftHorizontal
    ? Math.abs(left.from.y - right.from.y)
    : Math.abs(left.from.x - right.from.x);
  if (distance <= EPSILON || distance >= parallelGap - EPSILON) {
    return 0;
  }

  const [leftStart, leftEnd] = segmentProjection(left, leftHorizontal);
  const [rightStart, rightEnd] = segmentProjection(right, rightHorizontal);
  const overlap = Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart));
  return overlap <= parallelGap * 2 ? 0 : (parallelGap - distance) * overlap;
}

export function pointsEqual(left: GraphPoint, right: GraphPoint): boolean {
  return almostEqual(left.x, right.x) && almostEqual(left.y, right.y);
}

export function serializePoints(points: readonly GraphPoint[]): string {
  return points.map((point) => `${formatNumber(point.x)},${formatNumber(point.y)}`).join(";");
}

export function formatNumber(value: number): string {
  return Number(value.toFixed(3)).toString();
}

export function almostEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= EPSILON;
}

function intervalsOverlapInterior(
  firstStart: number,
  firstEnd: number,
  secondStart: number,
  secondEnd: number,
): boolean {
  return (
    Math.max(Math.min(firstStart, firstEnd), Math.min(secondStart, secondEnd)) <
    Math.min(Math.max(firstStart, firstEnd), Math.max(secondStart, secondEnd)) - EPSILON
  );
}

function segmentProjection(segment: GraphSegment, horizontal: boolean): readonly [number, number] {
  const start = horizontal
    ? Math.min(segment.from.x, segment.to.x)
    : Math.min(segment.from.y, segment.to.y);
  const end = horizontal
    ? Math.max(segment.from.x, segment.to.x)
    : Math.max(segment.from.y, segment.to.y);
  return [start, end];
}
