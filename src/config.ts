export type LogLevel = "debug" | "info" | "warn" | "error";

export type Config = {
  readonly host: string;
  readonly port: number;
  readonly dbPath: string;
  readonly adminToken: string | null;
  readonly probeConcurrency: number;
  readonly failureThreshold: number;
  readonly defaultTimeoutMs: number;
  readonly defaultIntervalSeconds: number;
  readonly retentionDays: number;
  readonly logLevel: LogLevel;
  readonly seedTargets: readonly string[];
  readonly sloTarget: number;
  readonly version: string;
  readonly env: string;
};

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

function readInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function readFloat(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function readLogLevel(raw: string | undefined): LogLevel {
  const value = (raw ?? "info").trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(value) ? (value as LogLevel) : "info";
}

function readList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Loads runtime configuration from environment variables with safe defaults. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const adminTokenRaw = (env.ADMIN_TOKEN ?? "").trim();
  return {
    host: env.HOST?.trim() || "0.0.0.0",
    port: readInt(env.PORT, 8080, 1, 65535),
    dbPath: env.DB_PATH?.trim() || "./data/sentinel.db",
    adminToken: adminTokenRaw.length >= 8 ? adminTokenRaw : null,
    probeConcurrency: readInt(env.PROBE_CONCURRENCY, 8, 1, 64),
    failureThreshold: readInt(env.FAILURE_THRESHOLD, 3, 1, 50),
    defaultTimeoutMs: readInt(env.DEFAULT_TIMEOUT_MS, 5000, 200, 120000),
    defaultIntervalSeconds: readInt(env.DEFAULT_INTERVAL_SECONDS, 60, 10, 86400),
    retentionDays: readInt(env.RETENTION_DAYS, 14, 1, 3650),
    logLevel: readLogLevel(env.LOG_LEVEL),
    seedTargets: readList(env.SEED_TARGETS),
    sloTarget: readFloat(env.SLO_TARGET, 0.999, 0.5, 1),
    version: env.APP_VERSION?.trim() || "dev",
    env: env.NODE_ENV?.trim() || "development",
  };
}
