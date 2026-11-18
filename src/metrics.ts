export type Labels = Record<string, string>;

type MetricType = "counter" | "gauge" | "histogram";

type Series = {
  name: string;
  help: string;
  type: MetricType;
  labels: Labels;
  value: number;
};

type HistogramSeries = {
  name: string;
  help: string;
  labels: Labels;
  buckets: number[];
  counts: number[];
  sum: number;
  count: number;
};

/** Default latency buckets in seconds, aligned with common HTTP SLO practice. */
export const DEFAULT_BUCKETS: readonly number[] = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function seriesKey(name: string, labels: Labels): string {
  const parts = Object.keys(labels)
    .sort()
    .map((key) => `${key}="${escapeLabelValue(labels[key] ?? "")}"`);
  return parts.length === 0 ? name : `${name}{${parts.join(",")}}`;
}

function formatValue(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(value);
}

/**
 * Minimal Prometheus text-format registry (exposition format 0.0.4).
 * Kept dependency-free on purpose: the whole point of the exercise is to show
 * what the client library does for you.
 */
export class Metrics {
  readonly #series = new Map<string, Series>();
  readonly #histograms = new Map<string, HistogramSeries>();
  readonly #startedAt = Date.now();

  inc(name: string, help: string, labels: Labels = {}, by = 1): void {
    const key = seriesKey(name, labels);
    const existing = this.#series.get(key);
    if (existing) {
      existing.value += by;
      return;
    }
    this.#series.set(key, { name, help, type: "counter", labels, value: by });
  }

  setGauge(name: string, help: string, value: number, labels: Labels = {}): void {
    const key = seriesKey(name, labels);
    this.#series.set(key, { name, help, type: "gauge", labels, value });
  }

  deleteGauge(name: string, labels: Labels = {}): void {
    this.#series.delete(seriesKey(name, labels));
  }

  observe(
    name: string,
    help: string,
    value: number,
    labels: Labels = {},
    buckets: readonly number[] = DEFAULT_BUCKETS,
  ): void {
    const key = seriesKey(name, labels);
    let histogram = this.#histograms.get(key);
    if (!histogram) {
      histogram = {
        name,
        help,
        labels,
        buckets: [...buckets],
        counts: new Array(buckets.length).fill(0),
        sum: 0,
        count: 0,
      };
      this.#histograms.set(key, histogram);
    }
    histogram.sum += value;
    histogram.count += 1;
    for (let index = 0; index < histogram.buckets.length; index += 1) {
      const bound = histogram.buckets[index] ?? Number.POSITIVE_INFINITY;
      if (value <= bound) {
        histogram.counts[index] = (histogram.counts[index] ?? 0) + 1;
      }
    }
  }

  uptimeSeconds(): number {
    return (Date.now() - this.#startedAt) / 1000;
  }

  /** Renders the full registry in Prometheus exposition format. */
  render(): string {
    const lines: string[] = [];
    const byName = new Map<string, Series[]>();
    for (const series of this.#series.values()) {
      const bucket = byName.get(series.name);
      if (bucket) bucket.push(series);
      else byName.set(series.name, [series]);
    }

    for (const name of [...byName.keys()].sort()) {
      const group = byName.get(name) ?? [];
      const first = group[0];
      if (!first) continue;
      lines.push(`# HELP ${name} ${first.help}`);
      lines.push(`# TYPE ${name} ${first.type}`);
      for (const series of [...group].sort((a, b) => seriesKey(a.name, a.labels).localeCompare(seriesKey(b.name, b.labels)))) {
        lines.push(`${seriesKey(series.name, series.labels)} ${formatValue(series.value)}`);
      }
    }

    const byHistogramName = new Map<string, HistogramSeries[]>();
    for (const histogram of this.#histograms.values()) {
      const bucket = byHistogramName.get(histogram.name);
      if (bucket) bucket.push(histogram);
      else byHistogramName.set(histogram.name, [histogram]);
    }

    for (const name of [...byHistogramName.keys()].sort()) {
      const group = byHistogramName.get(name) ?? [];
      const first = group[0];
      if (!first) continue;
      lines.push(`# HELP ${name} ${first.help}`);
      lines.push(`# TYPE ${name} histogram`);
      for (const histogram of group) {
        const base = Object.keys(histogram.labels).sort().map((key) => [key, histogram.labels[key] ?? ""] as const);
        for (let index = 0; index < histogram.buckets.length; index += 1) {
          const bound = histogram.buckets[index] ?? Number.POSITIVE_INFINITY;
          const pairs = [...base, ["le", String(bound)] as const];
          lines.push(`${name}{${pairs.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(",")}} ${histogram.counts[index] ?? 0}`);
        }
        const infPairs = [...base, ["le", "+Inf"] as const];
        lines.push(`${name}{${infPairs.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(",")}} ${histogram.count}`);
        lines.push(`${name}_sum${base.length > 0 ? `{${base.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(",")}}` : ""} ${formatValue(histogram.sum)}`);
        lines.push(`${name}_count${base.length > 0 ? `{${base.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(",")}}` : ""} ${histogram.count}`);
      }
    }

    return `${lines.join("\n")}\n`;
  }
}
