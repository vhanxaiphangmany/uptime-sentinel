import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type Target = {
  id: string;
  name: string;
  url: string;
  intervalSeconds: number;
  timeoutMs: number;
  expectedStatus: string;
  enabled: boolean;
  createdAt: string;
};

export type CheckRecord = {
  id: number;
  targetId: string;
  checkedAt: string;
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  error: string | null;
};

export type Incident = {
  id: string;
  targetId: string;
  startedAt: string;
  resolvedAt: string | null;
  reason: string | null;
  failedChecks: number;
};

export type NewTarget = {
  name: string;
  url: string;
  intervalSeconds: number;
  timeoutMs: number;
  expectedStatus: string;
};

type Row = Record<string, unknown>;

function toTarget(row: Row): Target {
  return {
    id: String(row.id),
    name: String(row.name),
    url: String(row.url),
    intervalSeconds: Number(row.interval_seconds),
    timeoutMs: Number(row.timeout_ms),
    expectedStatus: String(row.expected_status),
    enabled: Number(row.enabled) === 1,
    createdAt: String(row.created_at),
  };
}

function toCheck(row: Row): CheckRecord {
  return {
    id: Number(row.id),
    targetId: String(row.target_id),
    checkedAt: String(row.checked_at),
    ok: Number(row.ok) === 1,
    statusCode: row.status_code === null || row.status_code === undefined ? null : Number(row.status_code),
    latencyMs: Number(row.latency_ms),
    error: row.error === null || row.error === undefined ? null : String(row.error),
  };
}

function toIncident(row: Row): Incident {
  return {
    id: String(row.id),
    targetId: String(row.target_id),
    startedAt: String(row.started_at),
    resolvedAt: row.resolved_at === null || row.resolved_at === undefined ? null : String(row.resolved_at),
    reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
    failedChecks: Number(row.failed_checks),
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS targets (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  url              TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL,
  timeout_ms       INTEGER NOT NULL,
  expected_status  TEXT NOT NULL DEFAULT '200-299',
  enabled          INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id  TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  checked_at TEXT NOT NULL,
  ok         INTEGER NOT NULL,
  status_code INTEGER,
  latency_ms REAL NOT NULL,
  error      TEXT
);

CREATE INDEX IF NOT EXISTS idx_checks_target_time ON checks(target_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS incidents (
  id            TEXT PRIMARY KEY,
  target_id     TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  started_at    TEXT NOT NULL,
  resolved_at   TEXT,
  reason        TEXT,
  failed_checks INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_incidents_target ON incidents(target_id, started_at DESC);
`;

export class Db {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec("PRAGMA busy_timeout = 5000;");
    this.#db.exec("PRAGMA foreign_keys = ON;");
    this.#db.exec(SCHEMA);
  }

  close(): void {
    this.#db.close();
  }

  ping(): boolean {
    const row = this.#db.prepare("SELECT 1 AS ok").get() as Row | undefined;
    return Number(row?.ok) === 1;
  }

  createTarget(input: NewTarget): Target {
    const target: Target = {
      id: randomUUID(),
      name: input.name,
      url: input.url,
      intervalSeconds: input.intervalSeconds,
      timeoutMs: input.timeoutMs,
      expectedStatus: input.expectedStatus,
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    this.#db
      .prepare(
        `INSERT INTO targets (id, name, url, interval_seconds, timeout_ms, expected_status, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        target.id,
        target.name,
        target.url,
        target.intervalSeconds,
        target.timeoutMs,
        target.expectedStatus,
        target.createdAt,
      );
    return target;
  }

  listTargets(): Target[] {
    const rows = this.#db.prepare("SELECT * FROM targets ORDER BY created_at ASC").all() as Row[];
    return rows.map(toTarget);
  }

  getTarget(id: string): Target | null {
    const row = this.#db.prepare("SELECT * FROM targets WHERE id = ?").get(id) as Row | undefined;
    return row ? toTarget(row) : null;
  }

  deleteTarget(id: string): boolean {
    const result = this.#db.prepare("DELETE FROM targets WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  recordCheck(input: {
    targetId: string;
    ok: boolean;
    statusCode: number | null;
    latencyMs: number;
    error: string | null;
    checkedAt?: string;
  }): CheckRecord {
    const checkedAt = input.checkedAt ?? new Date().toISOString();
    const result = this.#db
      .prepare(
        `INSERT INTO checks (target_id, checked_at, ok, status_code, latency_ms, error)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.targetId, checkedAt, input.ok ? 1 : 0, input.statusCode, input.latencyMs, input.error);
    return {
      id: Number(result.lastInsertRowid),
      targetId: input.targetId,
      checkedAt,
      ok: input.ok,
      statusCode: input.statusCode,
      latencyMs: input.latencyMs,
      error: input.error,
    };
  }

  recentChecks(targetId: string, limit = 20): CheckRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM checks WHERE target_id = ? ORDER BY id DESC LIMIT ?")
      .all(targetId, Math.min(Math.max(Math.trunc(limit), 1), 500)) as Row[];
    return rows.map(toCheck);
  }

  checksSince(targetId: string, sinceIso: string): CheckRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM checks WHERE target_id = ? AND checked_at >= ? ORDER BY id DESC")
      .all(targetId, sinceIso) as Row[];
    return rows.map(toCheck);
  }

  latestCheck(targetId: string): CheckRecord | null {
    const row = this.#db.prepare("SELECT * FROM checks WHERE target_id = ? ORDER BY id DESC LIMIT 1").get(targetId) as
      | Row
      | undefined;
    return row ? toCheck(row) : null;
  }

  /** Number of trailing consecutive failed checks (ordered newest first). */
  consecutiveFailures(targetId: string, lookback = 20): number {
    const rows = this.#db
      .prepare("SELECT ok FROM checks WHERE target_id = ? ORDER BY id DESC LIMIT ?")
      .all(targetId, lookback) as Row[];
    let count = 0;
    for (const row of rows) {
      if (Number(row.ok) === 1) break;
      count += 1;
    }
    return count;
  }

  openIncidentFor(targetId: string): Incident | null {
    const row = this.#db
      .prepare("SELECT * FROM incidents WHERE target_id = ? AND resolved_at IS NULL ORDER BY started_at DESC LIMIT 1")
      .get(targetId) as Row | undefined;
    return row ? toIncident(row) : null;
  }

  openIncident(targetId: string, reason: string, failedChecks: number): Incident {
    const incident: Incident = {
      id: randomUUID(),
      targetId,
      startedAt: new Date().toISOString(),
      resolvedAt: null,
      reason,
      failedChecks,
    };
    this.#db
      .prepare("INSERT INTO incidents (id, target_id, started_at, resolved_at, reason, failed_checks) VALUES (?, ?, ?, NULL, ?, ?)")
      .run(incident.id, targetId, incident.startedAt, reason, failedChecks);
    return incident;
  }

  bumpIncident(incidentId: string, failedChecks: number): void {
    this.#db.prepare("UPDATE incidents SET failed_checks = ? WHERE id = ?").run(failedChecks, incidentId);
  }

  resolveIncident(incidentId: string): void {
    this.#db.prepare("UPDATE incidents SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL").run(
      new Date().toISOString(),
      incidentId,
    );
  }

  listIncidents(limit = 50): Incident[] {
    const rows = this.#db
      .prepare("SELECT * FROM incidents ORDER BY started_at DESC LIMIT ?")
      .all(Math.min(Math.max(Math.trunc(limit), 1), 500)) as Row[];
    return rows.map(toIncident);
  }

  countOpenIncidents(): number {
    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM incidents WHERE resolved_at IS NULL").get() as Row | undefined;
    return Number(row?.n ?? 0);
  }

  pruneChecks(olderThanIso: string): number {
    const result = this.#db.prepare("DELETE FROM checks WHERE checked_at < ?").run(olderThanIso);
    return Number(result.changes);
  }
}
