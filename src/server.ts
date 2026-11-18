import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Config } from "./config.ts";
import type { Db, Target } from "./db.ts";
import type { Logger } from "./logger.ts";
import type { Metrics } from "./metrics.ts";
import type { Scheduler } from "./scheduler.ts";
import { isValidStatusSpec } from "./probes.ts";
import { summarizeSlo, windowStartIso } from "./slo.ts";

export type ServerDeps = {
  config: Config;
  db: Db;
  metrics: Metrics;
  scheduler: Scheduler;
  logger: Logger;
};

const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8"): void {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number.parseInt(value, 10);
  return null;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

type TargetView = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  intervalSeconds: number;
  expectedStatus: string;
  lastCheck: {
    ok: boolean;
    statusCode: number | null;
    latencyMs: number;
    checkedAt: string;
    error: string | null;
  } | null;
  availability24h: number | null;
  incidents: number;
  openIncident: { startedAt: string; reason: string | null } | null;
};

function buildTargetView(db: Db, target: Target): TargetView {
  const latest = db.latestCheck(target.id);
  const checks = db.checksSince(target.id, windowStartIso("24h"));
  const slo = summarizeSlo(checks, 0.999, "24h");
  const open = db.openIncidentFor(target.id);
  const incidents = db.listIncidents(200).filter((incident) => incident.targetId === target.id);
  return {
    id: target.id,
    name: target.name,
    url: target.url,
    enabled: target.enabled,
    intervalSeconds: target.intervalSeconds,
    expectedStatus: target.expectedStatus,
    lastCheck: latest
      ? {
          ok: latest.ok,
          statusCode: latest.statusCode,
          latencyMs: latest.latencyMs,
          checkedAt: latest.checkedAt,
          error: latest.error,
        }
      : null,
    availability24h: slo.availability,
    incidents: incidents.length,
    openIncident: open ? { startedAt: open.startedAt, reason: open.reason } : null,
  };
}

function fmtPct(value: number | null): string {
  if (value === null) return "—";
  return `${(value * 100).toFixed(3)}%`;
}

function fmtRelative(iso: string | null): string {
  if (!iso) return "—";
  const deltaMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(deltaMs)) return "—";
  const seconds = Math.max(0, Math.round(deltaMs / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function renderStatusPage(views: readonly TargetView[], config: Config): string {
  const down = views.filter((view) => view.lastCheck && !view.lastCheck.ok).length;
  const openIncidents = views.filter((view) => view.openIncident !== null).length;
  const overall = views.length === 0 ? "no targets" : openIncidents > 0 ? "degraded" : down > 0 ? "partial outage" : "all systems operational";
  const overallClass = openIncidents > 0 ? "bad" : down > 0 ? "warn" : "good";

  const rows = views
    .map((view) => {
      const state = view.openIncident ? "bad" : view.lastCheck && !view.lastCheck.ok ? "warn" : "good";
      const label = view.openIncident ? "incident" : view.lastCheck ? (view.lastCheck.ok ? "up" : "down") : "pending";
      return `<tr>
        <td><span class="pill ${state}">${label}</span></td>
        <td><strong>${escapeHtml(view.name)}</strong><div class="muted mono">${escapeHtml(view.url)}</div></td>
        <td class="num">${view.lastCheck?.statusCode ?? "—"}</td>
        <td class="num">${view.lastCheck ? `${view.lastCheck.latencyMs.toFixed(0)} ms` : "—"}</td>
        <td class="num">${fmtPct(view.availability24h)}</td>
        <td class="num muted">${fmtRelative(view.lastCheck?.checkedAt ?? null)}</td>
      </tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>Uptime Sentinel — status</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 20px; font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         background: radial-gradient(1200px 600px at 20% -10%, #10243a 0%, #0b0f14 55%); color: #e6edf3; }
  main { max-width: 960px; margin: 0 auto; }
  header { display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; justify-content: space-between; margin-bottom: 22px; }
  h1 { font-size: 20px; margin: 0; letter-spacing: .2px; }
  h1 span { color: #7aa2f7; }
  .muted { color: #8b98a5; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-all; }
  .banner { border-radius: 12px; padding: 14px 18px; margin-bottom: 22px; font-weight: 600;
            display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .banner.good { background: #10261a; border: 1px solid #1f5133; color: #7ee2a8; }
  .banner.warn { background: #2a2312; border: 1px solid #5b4a15; color: #f2cc60; }
  .banner.bad  { background: #2a1416; border: 1px solid #5b1f24; color: #ff9ca4; }
  table { width: 100%; border-collapse: collapse; background: #0f151c; border: 1px solid #1e2732; border-radius: 12px; overflow: hidden; }
  th, td { padding: 11px 14px; text-align: left; border-bottom: 1px solid #1a222c; vertical-align: middle; }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: #8b98a5; background: #111a22; }
  tr:last-child td { border-bottom: 0; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .pill { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }
  .pill.good { background: #14351f; color: #7ee2a8; }
  .pill.warn { background: #3a2f10; color: #f2cc60; }
  .pill.bad  { background: #3a1a1e; color: #ff9ca4; }
  footer { margin-top: 22px; font-size: 12px; color: #6f7c8a; display: flex; gap: 16px; flex-wrap: wrap; }
  code { background: #131b24; padding: 1px 5px; border-radius: 4px; }
</style>
</head>
<body>
<main>
  <header>
    <h1>uptime<span>·</span>sentinel</h1>
    <div class="muted mono">v${escapeHtml(config.version)} · ${escapeHtml(config.env)}</div>
  </header>
  <div class="banner ${overallClass}">
    <span>${escapeHtml(overall)}</span>
    <span class="muted">${views.length} targets · ${openIncidents} open incidents · auto-refresh 30s</span>
  </div>
  <table>
    <thead>
      <tr><th>Status</th><th>Target</th><th class="num">Code</th><th class="num">Latency</th><th class="num">24h avail.</th><th class="num">Last check</th></tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="6" class="muted">No targets yet — POST /api/targets to add one.</td></tr>'}
    </tbody>
  </table>
  <footer>
    <span><code>GET /metrics</code> Prometheus</span>
    <span><code>GET /healthz</code> liveness</span>
    <span><code>GET /readyz</code> readiness</span>
    <span><code>GET /api/targets</code> JSON</span>
  </footer>
</main>
</body>
</html>`;
}

/** Builds the HTTP server with all routes wired to the given dependencies. */
export function createServer(deps: ServerDeps): Server {
  const { config, db, metrics, scheduler, logger } = deps;
  const log = logger.child({ component: "http" });

  const requireAdmin = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (config.adminToken === null) return true; // dev mode: no token configured
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (token === config.adminToken) return true;
    sendJson(res, 401, { error: "unauthorized", hint: "send Authorization: Bearer <ADMIN_TOKEN>" });
    return false;
  };

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const startedAt = Date.now();
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    res.on("finish", () => {
      metrics.inc("sentinel_http_requests_total", "HTTP requests served", {
        method,
        path: path.startsWith("/api/targets/") ? "/api/targets/:id" : path,
        status: String(res.statusCode),
      });
      log.debug("request", { method, path, status: res.statusCode, durationMs: Date.now() - startedAt });
    });

    try {
      // ---- operational endpoints (no auth, used by Kubernetes) ----
      if (path === "/healthz" && method === "GET") {
        sendText(res, 200, "ok\n");
        return;
      }

      if (path === "/readyz" && method === "GET") {
        const dbOk = db.ping();
        const running = scheduler.isRunning;
        if (dbOk && running) {
          sendJson(res, 200, { status: "ready", db: "ok", scheduler: "running" });
        } else {
          sendJson(res, 503, { status: "not-ready", db: dbOk ? "ok" : "error", scheduler: running ? "running" : "stopped" });
        }
        return;
      }

      if (path === "/metrics" && method === "GET") {
        metrics.setGauge("sentinel_build_info", "Build information", 1, { version: config.version, env: config.env });
        metrics.setGauge("sentinel_process_uptime_seconds", "Process uptime in seconds", metrics.uptimeSeconds());
        metrics.setGauge("sentinel_targets_total", "Number of configured targets", db.listTargets().length);
        metrics.setGauge("sentinel_incidents_open", "Currently open incidents", db.countOpenIncidents());
        sendText(res, 200, metrics.render(), "text/plain; version=0.0.4; charset=utf-8");
        return;
      }

      if (path === "/" && method === "GET") {
        const views = db.listTargets().map((target) => buildTargetView(db, target));
        sendText(res, 200, renderStatusPage(views, config), "text/html; charset=utf-8");
        return;
      }

      // ---- JSON API ----
      if (path === "/api/version" && method === "GET") {
        sendJson(res, 200, { name: "uptime-sentinel", version: config.version, env: config.env, node: process.version });
        return;
      }

      if (path === "/api/targets" && method === "GET") {
        sendJson(res, 200, { targets: db.listTargets().map((target) => buildTargetView(db, target)) });
        return;
      }

      if (path === "/api/targets" && method === "POST") {
        if (!requireAdmin(req, res)) return;
        const body = await readJsonBody(req);
        const name = asString(body.name);
        const targetUrl = asString(body.url);
        if (!name) {
          sendJson(res, 400, { error: "invalid_request", field: "name" });
          return;
        }
        if (!targetUrl || !isHttpUrl(targetUrl)) {
          sendJson(res, 400, { error: "invalid_request", field: "url", hint: "http(s) URL required" });
          return;
        }
        const expectedStatus = asString(body.expectedStatus) ?? "200-299";
        if (!isValidStatusSpec(expectedStatus)) {
          sendJson(res, 400, { error: "invalid_request", field: "expectedStatus", hint: 'e.g. "200-299", "200,301", "*"' });
          return;
        }
        const intervalSeconds = asInt(body.intervalSeconds) ?? config.defaultIntervalSeconds;
        const timeoutMs = asInt(body.timeoutMs) ?? config.defaultTimeoutMs;
        if (intervalSeconds < 10 || intervalSeconds > 86400) {
          sendJson(res, 400, { error: "invalid_request", field: "intervalSeconds", hint: "10..86400" });
          return;
        }
        if (timeoutMs < 200 || timeoutMs > 120000) {
          sendJson(res, 400, { error: "invalid_request", field: "timeoutMs", hint: "200..120000" });
          return;
        }

        const target = db.createTarget({ name, url: targetUrl, intervalSeconds, timeoutMs, expectedStatus });
        scheduler.schedule(target);
        log.info("target created", { target: target.name, id: target.id });
        void scheduler.runOnce(target.id);
        sendJson(res, 201, { target });
        return;
      }

      const targetMatch = /^\/api\/targets\/([A-Za-z0-9-]+)(\/checks|\/check)?$/.exec(path);
      if (targetMatch) {
        const targetId = targetMatch[1] ?? "";
        const suffix = targetMatch[2] ?? "";
        const target = db.getTarget(targetId);
        if (!target) {
          sendJson(res, 404, { error: "target_not_found", id: targetId });
          return;
        }

        if (suffix === "" && method === "GET") {
          sendJson(res, 200, { target: buildTargetView(db, target) });
          return;
        }

        if (suffix === "" && method === "DELETE") {
          if (!requireAdmin(req, res)) return;
          db.deleteTarget(targetId);
          scheduler.unschedule(targetId);
          log.info("target deleted", { target: target.name, id: target.id });
          sendJson(res, 200, { deleted: targetId });
          return;
        }

        if (suffix === "/checks" && method === "GET") {
          const limit = asInt(url.searchParams.get("limit")) ?? 20;
          sendJson(res, 200, { targetId, checks: db.recentChecks(targetId, limit) });
          return;
        }

        if (suffix === "/check" && method === "POST") {
          if (!requireAdmin(req, res)) return;
          const result = await scheduler.runOnce(targetId);
          if (!result) {
            sendJson(res, 409, { error: "probe_skipped", hint: "a probe for this target is already in flight" });
            return;
          }
          sendJson(res, 200, { targetId, result });
          return;
        }
      }

      if (path === "/api/incidents" && method === "GET") {
        const limit = asInt(url.searchParams.get("limit")) ?? 50;
        sendJson(res, 200, { incidents: db.listIncidents(limit) });
        return;
      }

      if (path === "/api/slo" && method === "GET") {
        const window = url.searchParams.get("window") ?? "24h";
        const since = windowStartIso(window);
        const targets = db.listTargets().map((target) => {
          const summary = summarizeSlo(db.checksSince(target.id, since), config.sloTarget, window);
          return { targetId: target.id, name: target.name, ...summary };
        });
        sendJson(res, 200, { sloTarget: config.sloTarget, window, targets });
        return;
      }

      sendJson(res, 404, { error: "not_found", path });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isClientError = message === "body too large" || error instanceof SyntaxError || message.includes("JSON");
      log.warn("request failed", { path, err: error });
      if (!res.headersSent) {
        sendJson(res, isClientError ? 400 : 500, { error: isClientError ? "invalid_request" : "internal_error", message });
      }
    }
  };

  return createHttpServer((req, res) => {
    void handler(req, res);
  });
}
