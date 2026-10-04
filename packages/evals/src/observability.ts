import type {
  EvalCounterName,
  EvalHistogramName,
  EvalLogEntry,
  EvalLogger,
  EvalMetricLabels,
  EvalMetrics,
} from "./types.js";

export class NoopEvalLogger implements EvalLogger {
  public log(_entry: EvalLogEntry): void {}
}

export class NoopEvalMetrics implements EvalMetrics {
  public increment(_name: EvalCounterName, _labels: EvalMetricLabels): void {}

  public observe(_name: EvalHistogramName, _value: number, _labels: EvalMetricLabels): void {}
}

export function writeEvalLog(logger: EvalLogger, entry: EvalLogEntry): void {
  try {
    logger.log(entry);
  } catch {
    // Observability adapters cannot alter evaluation behavior.
  }
}

export function incrementEvalMetric(
  metrics: EvalMetrics,
  name: EvalCounterName,
  labels: EvalMetricLabels,
): void {
  try {
    metrics.increment(name, labels);
  } catch {
    // Observability adapters cannot alter evaluation behavior.
  }
}

export function observeEvalMetric(
  metrics: EvalMetrics,
  name: EvalHistogramName,
  value: number,
  labels: EvalMetricLabels,
): void {
  try {
    metrics.observe(name, value, labels);
  } catch {
    // Observability adapters cannot alter evaluation behavior.
  }
}
