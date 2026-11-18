import test from "node:test";
import assert from "node:assert/strict";
import { Db } from "../src/db.ts";
import { createLogger } from "../src/logger.ts";
import { Metrics } from "../src/metrics.ts";
import { Scheduler, type SchedulerOptions } from "../src/scheduler.ts";

const silentLogger = createLogger("error", {}, () => undefined);

function setup(options: Partial<SchedulerOptions> = {}) {
  const db = new Db(":memory:");
  const metrics = new Metrics();
  const target = db.createTarget({
    name: "Example",
    url: "https://example.com",
    intervalSeconds: 60,
    timeoutMs: 1000,
    expectedStatus: "200-299",
  });
  const scheduler = new Scheduler({
    db,
    metrics,
    logger: silentLogger,
    failureThreshold: 3,
    randomFn: () => 0.5,
    ...options,
  });
  return { db, metrics, target, scheduler };
}

test("runOnce records a check and publishes metrics", async () => {
  const { db, metrics, target, scheduler } = setup({
    probeFn: async () => ({ ok: true, statusCode: 200, latencyMs: 33, error: null, checkedAt: new Date().toISOString() }),
  });

  const result = await scheduler.runOnce(target.id);
  assert.deepEqual(result, { ok: true, latencyMs: 33 });
  assert.equal(db.recentChecks(target.id, 5).length, 1);
  assert.match(metrics.render(), /sentinel_target_up\{target="Example",url="https:\/\/example.com"\} 1/);

  await scheduler.stop();
  db.close();
});

test("an incident opens after the failure threshold and resolves on recovery", async () => {
  let healthy = false;
  const { db, target, scheduler } = setup({
    failureThreshold: 3,
    probeFn: async () => ({
      ok: healthy,
      statusCode: healthy ? 200 : 503,
      latencyMs: 12,
      error: healthy ? null : "unexpected status 503",
      checkedAt: new Date().toISOString(),
    }),
  });

  await scheduler.runOnce(target.id);
  await scheduler.runOnce(target.id);
  assert.equal(db.countOpenIncidents(), 0, "two failures are below the threshold");

  await scheduler.runOnce(target.id);
  assert.equal(db.countOpenIncidents(), 1, "third failure opens an incident");
  assert.equal(db.openIncidentFor(target.id)?.reason, "unexpected status 503");

  await scheduler.runOnce(target.id);
  assert.equal(db.openIncidentFor(target.id)?.failedChecks, 4, "still-open incident keeps its counter");

  healthy = true;
  await scheduler.runOnce(target.id);
  assert.equal(db.countOpenIncidents(), 0, "recovery resolves the incident");
  assert.equal(db.listIncidents(5).length, 1);

  await scheduler.stop();
  db.close();
});

test("runOnce returns null for unknown targets and after shutdown", async () => {
  const { db, target, scheduler } = setup({
    probeFn: async () => ({ ok: true, statusCode: 200, latencyMs: 1, error: null, checkedAt: new Date().toISOString() }),
  });

  assert.equal(await scheduler.runOnce("does-not-exist"), null);
  await scheduler.stop();
  assert.equal(await scheduler.runOnce(target.id), null);
  db.close();
});
