import test from "node:test";
import assert from "node:assert/strict";
import { parseWindow, summarizeSlo, windowStartIso } from "../src/slo.ts";

test("summarizeSlo returns no_data for an empty window", () => {
  const summary = summarizeSlo([], 0.999, "1h");
  assert.equal(summary.status, "no_data");
  assert.equal(summary.availability, null);
  assert.equal(summary.budgetRemaining, null);
});

test("summarizeSlo reports perfect availability as healthy", () => {
  const summary = summarizeSlo([{ ok: true }, { ok: true }, { ok: true }], 0.999, "24h");
  assert.equal(summary.availability, 1);
  assert.equal(summary.burnRate, 0);
  assert.equal(summary.budgetRemaining, 1);
  assert.equal(summary.status, "healthy");
});

test("summarizeSlo detects error budget exhaustion", () => {
  const checks = Array.from({ length: 100 }, (_, index) => ({ ok: index >= 10 }));
  const summary = summarizeSlo(checks, 0.999, "24h");

  assert.equal(summary.totalChecks, 100);
  assert.equal(summary.failedChecks, 10);
  assert.equal(summary.availability, 0.9);
  assert.equal(summary.budgetRemaining, 0);
  assert.equal(summary.status, "breached");
});

test("summarizeSlo grades burn rate into healthy / at_risk / breached", () => {
  const withFailures = (failures: number) =>
    Array.from({ length: 1000 }, (_, index) => ({ ok: index >= failures }));

  // 99% SLO => 10 failed checks per 1000 burn the budget exactly.
  assert.equal(summarizeSlo(withFailures(3), 0.99, "24h").status, "healthy");
  assert.equal(summarizeSlo(withFailures(7), 0.99, "24h").status, "at_risk");
  assert.equal(summarizeSlo(withFailures(10), 0.99, "24h").status, "breached");

  const atRisk = summarizeSlo(withFailures(7), 0.99, "24h");
  assert.equal(Math.round((atRisk.burnRate ?? 0) * 10) / 10, 0.7);
  assert.equal(atRisk.budgetRemaining !== null && atRisk.budgetRemaining > 0, true);
});

test("parseWindow understands s/m/h/d suffixes", () => {
  assert.equal(parseWindow("30m"), 1_800_000);
  assert.equal(parseWindow("24h"), 86_400_000);
  assert.equal(parseWindow("7d"), 604_800_000);
  assert.equal(parseWindow("45s"), 45_000);
  assert.equal(parseWindow("garbage", 1234), 1234);
});

test("windowStartIso subtracts the window from now", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  assert.equal(windowStartIso("1h", now), "2025-12-31T23:00:00.000Z");
});
