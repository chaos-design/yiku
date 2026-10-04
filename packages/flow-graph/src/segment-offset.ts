import { FlowGraphError } from "./errors.js";
import {
  almostEqual,
  compactOrthogonalPoints,
  isOrthogonalSegment,
  toSegments,
} from "./geometry.js";
import type { GraphPoint, SegmentOffsets } from "./types.js";

interface ShiftedLine {
  readonly coordinate: number;
  readonly horizontal: boolean;
}

export function offsetOrthogonalRoute(
  points: readonly GraphPoint[],
  segmentOffsets: SegmentOffsets,
): readonly GraphPoint[] {
  const normalizedPoints = normalizePoints(points);
  const segments = toSegments(normalizedPoints);
  const offsets = normalizeOffsets(segmentOffsets, segments.length);
  const lines = segments.map((segment, index) => ({
    coordinate:
      (almostEqual(segment.from.y, segment.to.y) ? segment.from.y : segment.from.x) +
      (offsets.get(index + 1) ?? 0),
    horizontal: almostEqual(segment.from.y, segment.to.y),
  }));
  const start = normalizedPoints[0];
  const end = normalizedPoints.at(-1);
  const firstLine = lines[0];
  const lastLine = lines.at(-1);
  if (
    start === undefined ||
    end === undefined ||
    firstLine === undefined ||
    lastLine === undefined
  ) {
    throw invalidSegmentOffset("Flow graph route must contain at least one segment.", "points");
  }

  const offsetPoints: GraphPoint[] = [{ ...start }];
  appendPoint(offsetPoints, projectPoint(start, firstLine));
  for (let index = 1; index < lines.length; index += 1) {
    const previous = lines[index - 1];
    const current = lines[index];
    if (
      previous === undefined ||
      current === undefined ||
      previous.horizontal === current.horizontal
    ) {
      throw invalidSegmentOffset(
        "Flow graph route must alternate horizontal and vertical segments.",
        `points[${index}]`,
      );
    }
    appendPoint(offsetPoints, intersectLines(previous, current));
  }
  appendPoint(offsetPoints, projectPoint(end, lastLine));
  appendPoint(offsetPoints, end);

  return compactOrthogonalPoints(offsetPoints).map((point) => ({ ...point }));
}

function normalizePoints(points: readonly GraphPoint[]): readonly GraphPoint[] {
  if (!Array.isArray(points)) {
    throw invalidSegmentOffset("Flow graph route points must be an array.", "points");
  }
  const copied = points.map((point, index) => {
    if (!isRecord(point)) {
      throw invalidSegmentOffset("Flow graph route point must be an object.", `points[${index}]`);
    }
    const x = point.x;
    const y = point.y;
    if (typeof x !== "number" || !Number.isFinite(x)) {
      throw invalidSegmentOffset(
        "Flow graph route point x must be a finite number.",
        `points[${index}].x`,
      );
    }
    if (typeof y !== "number" || !Number.isFinite(y)) {
      throw invalidSegmentOffset(
        "Flow graph route point y must be a finite number.",
        `points[${index}].y`,
      );
    }
    return { x, y };
  });
  const normalized = compactOrthogonalPoints(copied);
  if (normalized.length < 2) {
    throw invalidSegmentOffset("Flow graph route must contain at least one segment.", "points");
  }
  for (const [index, segment] of toSegments(normalized).entries()) {
    if (!isOrthogonalSegment(segment)) {
      throw invalidSegmentOffset(
        "Flow graph route segments must be horizontal or vertical.",
        `points[${index + 1}]`,
      );
    }
  }
  return normalized;
}

function normalizeOffsets(
  segmentOffsets: SegmentOffsets,
  segmentCount: number,
): ReadonlyMap<number, number> {
  if (!isRecord(segmentOffsets) || Array.isArray(segmentOffsets)) {
    throw invalidSegmentOffset("Flow graph segment offsets must be an object.", "segmentOffsets");
  }
  const offsets = new Map<number, number>();
  for (const [key, value] of Object.entries(segmentOffsets)) {
    if (!/^[1-9]\d*$/u.test(key)) {
      throw invalidSegmentOffset(
        "Flow graph segment offset keys must be canonical positive integers.",
        `segmentOffsets.${key}`,
      );
    }
    const segment = Number(key);
    if (!Number.isSafeInteger(segment) || segment > segmentCount) {
      throw invalidSegmentOffset(
        `Flow graph segment offset ${segment} exceeds the route segment count ${segmentCount}.`,
        `segmentOffsets.${key}`,
        { segment, segmentCount },
      );
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw invalidSegmentOffset(
        "Flow graph segment offset must be a finite number.",
        `segmentOffsets.${key}`,
        { segment },
      );
    }
    offsets.set(segment, value);
  }
  return offsets;
}

function projectPoint(point: GraphPoint, line: ShiftedLine): GraphPoint {
  return line.horizontal ? { x: point.x, y: line.coordinate } : { x: line.coordinate, y: point.y };
}

function intersectLines(left: ShiftedLine, right: ShiftedLine): GraphPoint {
  const horizontal = left.horizontal ? left : right;
  const vertical = left.horizontal ? right : left;
  return {
    x: vertical.coordinate,
    y: horizontal.coordinate,
  };
}

function appendPoint(points: GraphPoint[], point: GraphPoint): void {
  const previous = points.at(-1);
  if (
    previous === undefined ||
    !almostEqual(previous.x, point.x) ||
    !almostEqual(previous.y, point.y)
  ) {
    points.push({ ...point });
  }
}

function invalidSegmentOffset(
  message: string,
  path: string,
  details?: Readonly<Record<string, unknown>>,
): FlowGraphError {
  return new FlowGraphError("FLOW_GRAPH_INVALID_SEGMENT_OFFSET", message, {
    ...(details === undefined ? {} : { details }),
    path,
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}
