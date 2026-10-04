import { formatNumber } from "./geometry.js";
import type { GraphPoint } from "./types.js";

export function toRoundedSvgPath(points: readonly GraphPoint[], radius = 7): string {
  const first = points[0];
  if (first === undefined) {
    return "";
  }

  const commands = [`M ${formatNumber(first.x)} ${formatNumber(first.y)}`];
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1] as GraphPoint;
    const current = points[index] as GraphPoint;
    const next = points[index + 1] as GraphPoint;

    const cornerRadius = Math.min(
      Math.max(0, radius),
      distance(previous, current) / 2,
      distance(current, next) / 2,
    );
    const entry = pointToward(current, previous, cornerRadius);
    const exit = pointToward(current, next, cornerRadius);
    commands.push(`L ${formatNumber(entry.x)} ${formatNumber(entry.y)}`);
    commands.push(
      `Q ${formatNumber(current.x)} ${formatNumber(current.y)} ${formatNumber(exit.x)} ${formatNumber(exit.y)}`,
    );
  }

  const last = points.at(-1);
  if (last !== undefined && last !== first) {
    commands.push(`L ${formatNumber(last.x)} ${formatNumber(last.y)}`);
  }
  return commands.join(" ");
}

function distance(left: GraphPoint, right: GraphPoint): number {
  return Math.abs(left.x - right.x) + Math.abs(left.y - right.y);
}

function pointToward(origin: GraphPoint, target: GraphPoint, amount: number): GraphPoint {
  if (origin.x === target.x) {
    return {
      x: origin.x,
      y: origin.y + Math.sign(target.y - origin.y) * amount,
    };
  }
  return {
    x: origin.x + Math.sign(target.x - origin.x) * amount,
    y: origin.y,
  };
}
