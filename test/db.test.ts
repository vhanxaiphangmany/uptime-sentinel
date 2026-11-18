import test from "node:test";
import assert from "node:assert/strict";
import { Db } from "../src/db.ts";

function freshDb(): Db {
  return new Db(":memory:");
}

test("targets can be created, listed and deleted", () => {
  const db = freshDb();
  const target = db.createTarget({
    name: "Example",
    url: "https://example.com",
    intervalSeconds: 60,
    timeoutMs: 5000,
    expectedStatus: "200-299",
  });

  assert.equal(db.listTargets().length, 1);
  assert.equal(db.getTarget(target.id)?.name, "Example");
  assert.equal(db.deleteTarget(target.id), true);
  assert.equal(db.deleteTarget(target.id), false);
  assert.equal(db.listTargets().length, 0);
  db.close();
});

test("checks are recorded newest first with typed fields", () => {
  const db = freshDb();
  const target = db.createTarget({
    name: "Example",
    url: "https://example.com",
    intervalSeconds: 60,
    timeoutMs: 5000,
    expectedStatus: "200-299",
  });

  db.recordCheck({ targetId: target.id, ok: true, statusCode: 200, latencyMs: 42.5, error: null });
  db.recordCheck({ targetId: target.id, ok: false, statusCode: null, latencyMs: 5000, error: "timeout" });

  const checks = db.recentChecks(target.id, 10);
  assert.equal(checks.length, 2);
  assert.equal(checks[0]?.ok, false);
  assert.equal(checks[0]?.error, "timeout");
  assert.equal(checks[1]?.ok, true);
  assert.equal(checks[1]?.latencyMs, 42.5);
  assert.equal(db.latestCheck(target.id)?.id, checks[0]?.id);
  db.close();
});

test("consecutiveFailures counts only the trailing streak", () => {
  const db = freshDb();
  const target = db.createTarget({
    name: "Example",
    url: "https://example.com",
    intervalSeconds: 60,
    timeoutMs: 5000,
    expectedStatus: "200-299",
  });

  const push = (ok: boolean) => db.recordCheck({ targetId: target.id, ok, statusCode: ok ? 200 : 500, latencyMs: 10, error: null });

  push(false);
  push(false);
  push(true);
  assert.equal(db.consecutiveFailures(target.id), 0);

  push(false);
  push(false);
  push(false);
  assert.equal(db.consecutiveFailures(target.id), 3);
  db.close();
});

test("incidents open once and resolve once", () => {
  const db = freshDb();
  const target = db.createTarget({
    name: "Example",
    url: "https://example.com",
    intervalSeconds: 60,
    timeoutMs: 5000,
    expectedStatus: "200-299",
  });

  const incident = db.openIncident(target.id, "timeout", 3);
  assert.equal(db.countOpenIncidents(), 1);
  assert.equal(db.openIncidentFor(target.id)?.id, incident.id);

  db.bumpIncident(incident.id, 5);
  assert.equal(db.openIncidentFor(target.id)?.failedChecks, 5);

  db.resolveIncident(incident.id);
  assert.equal(db.countOpenIncidents(), 0);
  assert.equal(db.openIncidentFor(target.id), null);

  const history = db.listIncidents(10);
  assert.equal(history.length, 1);
  assert.notEqual(history[0]?.resolvedAt, null);
  db.close();
});

test("pruneChecks removes only rows older than the cutoff", () => {
  const db = freshDb();
  const target = db.createTarget({
    name: "Example",
    url: "https://example.com",
    intervalSeconds: 60,
    timeoutMs: 5000,
    expectedStatus: "200-299",
  });

  db.recordCheck({
    targetId: target.id,
    ok: true,
    statusCode: 200,
    latencyMs: 10,
    error: null,
    checkedAt: "2020-01-01T00:00:00.000Z",
  });
  db.recordCheck({ targetId: target.id, ok: true, statusCode: 200, latencyMs: 10, error: null });

  assert.equal(db.pruneChecks("2021-01-01T00:00:00.000Z"), 1);
  assert.equal(db.recentChecks(target.id, 10).length, 1);
  db.close();
});

test("ping reports database health", () => {
  const db = freshDb();
  assert.equal(db.ping(), true);
  db.close();
});
