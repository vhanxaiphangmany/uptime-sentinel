import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Config } from "../src/config.ts";
import { Db } from "../src/db.ts";
import { createLogger } from "../src/logger.ts";
import { Metrics } from "../src/metrics.ts";
import { Scheduler } from "../src/scheduler.ts";
import { createServer } from "../src/server.ts";

const ADMIN_TOKEN = "test-token-123";

const testConfig: Config = {
  host: "127.0.0.1",
  port: 0,
  dbPath: ":memory:",
  adminToken: ADMIN_TOKEN,
  probeConcurrency: 4,
  failureThreshold: 3,
  defaultTimeoutMs: 1000,
  defaultIntervalSeconds: 60,
  retentionDays: 7,
  logLevel: "error",
  seedTargets: [],
  sloTarget: 0.999,
  version: "test",
  env: "test",
};

type Harness = {
  base: string;
  db: Db;
  metrics: Metrics;
  scheduler: Scheduler;
  close: () => Promise<void>;
};

async function harness(): Promise<Harness> {
  const db = new Db(":memory:");
  const metrics = new Metrics();
  const logger = createLogger("error", {}, () => undefined);
  const scheduler = new Scheduler({
    db,
    metrics,
    logger,
    randomFn: () => 0.5,
    probeFn: async () => ({ ok: true, statusCode: 200, latencyMs: 21, error: null, checkedAt: new Date().toISOString() }),
  });
  const server = createServer({ config: testConfig, db, metrics, scheduler, logger });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${address.port}`,
    db,
    metrics,
    scheduler,
    close: async () => {
      await scheduler.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}

const authHeaders = { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" };

test("liveness and readiness probes answer for Kubernetes", async (t) => {
  const app = await harness();
  t.after(() => app.close());

  const health = await fetch(`${app.base}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.text()).trim(), "ok");

  const ready = await fetch(`${app.base}/readyz`);
  assert.equal(ready.status, 200);
  assert.equal((await ready.json() as { status: string }).status, "ready");
});

test("metrics endpoint exposes the Prometheus text format", async (t) => {
  const app = await harness();
  t.after(() => app.close());

  const response = await fetch(`${app.base}/metrics`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/plain/);
  assert.match(body, /sentinel_build_info\{env="test",version="test"\} 1/);
  assert.match(body, /sentinel_targets_total 0/);
});

test("creating a target requires the admin token", async (t) => {
  const app = await harness();
  t.after(() => app.close());

  const payload = JSON.stringify({ name: "Example", url: "https://example.com" });

  const anonymous = await fetch(`${app.base}/api/targets`, { method: "POST", body: payload, headers: { "content-type": "application/json" } });
  assert.equal(anonymous.status, 401);

  const authorized = await fetch(`${app.base}/api/targets`, { method: "POST", body: payload, headers: authHeaders });
  assert.equal(authorized.status, 201);
  const created = (await authorized.json()) as { target: { id: string; name: string } };
  assert.equal(created.target.name, "Example");
  assert.equal(app.db.listTargets().length, 1);
});

test("target validation rejects bad urls and bad status specs", async (t) => {
  const app = await harness();
  t.after(() => app.close());

  const badUrl = await fetch(`${app.base}/api/targets`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ name: "bad", url: "ftp://example.com" }),
  });
  assert.equal(badUrl.status, 400);
  assert.equal((await badUrl.json() as { field: string }).field, "url");

  const badSpec = await fetch(`${app.base}/api/targets`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ name: "bad", url: "https://example.com", expectedStatus: "nope" }),
  });
  assert.equal(badSpec.status, 400);

  const tooFast = await fetch(`${app.base}/api/targets`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ name: "bad", url: "https://example.com", intervalSeconds: 1 }),
  });
  assert.equal(tooFast.status, 400);

  assert.equal(app.db.listTargets().length, 0);
});

test("a manual check is stored and exposed over the API", async (t) => {
  const app = await harness();
  t.after(() => app.close());

  const created = (await (
    await fetch(`${app.base}/api/targets`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ name: "Example", url: "https://example.com" }),
    })
  ).json()) as { target: { id: string } };
  const id = created.target.id;

  // wait for the immediate background probe to settle so the manual check isn't skipped
  await new Promise((resolve) => setTimeout(resolve, 500));

  const run = await fetch(`${app.base}/api/targets/${id}/check`, { method: "POST", headers: authHeaders, body: "{}" });
  assert.equal(run.status, 200);

  const checks = (await (await fetch(`${app.base}/api/targets/${id}/checks?limit=5`)).json()) as {
    checks: { ok: boolean; latencyMs: number }[];
  };
  assert.equal(checks.checks.length, 2); // one background probe + one manual probe
  assert.equal(checks.checks.every((c) => c.ok), true);

  const list = (await (await fetch(`${app.base}/api/targets`)).json()) as {
    targets: { id: string; availability24h: number }[];
  };
  assert.equal(list.targets.length, 1);
  assert.equal(list.targets[0]?.availability24h, 1);

  const slo = (await (await fetch(`${app.base}/api/slo?window=24h`)).json()) as {
    targets: { status: string }[];
  };
  assert.equal(slo.targets[0]?.status, "healthy");
});

test("the status page renders the target list as HTML", async (t) => {
  const app = await harness();
  t.after(() => app.close());

  await fetch(`${app.base}/api/targets`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ name: "Public API", url: "https://example.com/health" }),
  });

  const page = await fetch(`${app.base}/`);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.match(html, /Public API/);
  assert.match(html, /all systems operational|degraded|partial outage|no targets/);
});

test("unknown routes return a JSON 404", async (t) => {
  const app = await harness();
  t.after(() => app.close());

  const response = await fetch(`${app.base}/nope`);
  assert.equal(response.status, 404);
  assert.equal((await response.json() as { error: string }).error, "not_found");
});

test("malformed JSON bodies return 400 instead of crashing", async (t) => {
  const app = await harness();
  t.after(() => app.close());

  const response = await fetch(`${app.base}/api/targets`, {
    method: "POST",
    headers: authHeaders,
    body: "{not json",
  });
  assert.equal(response.status, 400);
});