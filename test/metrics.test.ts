import test from "node:test";
import assert from "node:assert/strict";
import { Metrics } from "../src/metrics.ts";

test("counters accumulate per label set", () => {
  const metrics = new Metrics();
  metrics.inc("sentinel_checks_total", "Total probes", { result: "ok" });
  metrics.inc("sentinel_checks_total", "Total probes", { result: "ok" }, 2);
  metrics.inc("sentinel_checks_total", "Total probes", { result: "fail" });

  const text = metrics.render();
  assert.match(text, /# TYPE sentinel_checks_total counter/);
  assert.match(text, /sentinel_checks_total\{result="ok"\} 3/);
  assert.match(text, /sentinel_checks_total\{result="fail"\} 1/);
});

test("gauges overwrite and can be deleted", () => {
  const metrics = new Metrics();
  metrics.setGauge("sentinel_target_up", "Up", 1, { target: "api" });
  metrics.setGauge("sentinel_target_up", "Up", 0, { target: "api" });
  assert.match(metrics.render(), /sentinel_target_up\{target="api"\} 0/);

  metrics.deleteGauge("sentinel_target_up", { target: "api" });
  assert.doesNotMatch(metrics.render(), /sentinel_target_up\{/);
});

test("histograms expose cumulative buckets, sum and count", () => {
  const metrics = new Metrics();
  metrics.observe("sentinel_probe_duration_seconds", "Latency", 0.03, { target: "api" }, [0.05, 0.5, 1]);
  metrics.observe("sentinel_probe_duration_seconds", "Latency", 0.7, { target: "api" }, [0.05, 0.5, 1]);

  const text = metrics.render();
  assert.match(text, /# TYPE sentinel_probe_duration_seconds histogram/);
  assert.match(text, /sentinel_probe_duration_seconds\{target="api",le="0.05"\} 1/);
  assert.match(text, /sentinel_probe_duration_seconds\{target="api",le="0.5"\} 1/);
  assert.match(text, /sentinel_probe_duration_seconds\{target="api",le="1"\} 2/);
  assert.match(text, /sentinel_probe_duration_seconds\{target="api",le="\+Inf"\} 2/);
  assert.match(text, /sentinel_probe_duration_seconds_sum\{target="api"\} 0.73/);
  assert.match(text, /sentinel_probe_duration_seconds_count\{target="api"\} 2/);
});

test("label values are escaped", () => {
  const metrics = new Metrics();
  metrics.setGauge("sentinel_weird", "Weird", 1, { note: 'a"b\\c' });
  assert.match(metrics.render(), /note="a\\"b\\\\c"/);
});
