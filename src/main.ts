import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { createLogger } from "./logger.ts";
import { Metrics } from "./metrics.ts";
import { Scheduler } from "./scheduler.ts";
import { createServer } from "./server.ts";

const config = loadConfig();
const logger = createLogger(config.logLevel, { service: "uptime-sentinel", version: config.version, env: config.env });

const db = new Db(config.dbPath);
const metrics = new Metrics();
const scheduler = new Scheduler({
  db,
  metrics,
  logger,
  concurrency: config.probeConcurrency,
  failureThreshold: config.failureThreshold,
});

// Seed targets from SEED_TARGETS="name=url,name=url" when the database is empty.
if (db.listTargets().length === 0) {
  for (const entry of config.seedTargets) {
    const separator = entry.indexOf("=");
    const name = separator > 0 ? entry.slice(0, separator).trim() : entry.trim();
    const url = separator > 0 ? entry.slice(separator + 1).trim() : entry.trim();
    if (!name || !url) continue;
    const target = db.createTarget({
      name,
      url,
      intervalSeconds: config.defaultIntervalSeconds,
      timeoutMs: config.defaultTimeoutMs,
      expectedStatus: "200-299",
    });
    logger.info("seeded target", { target: target.name, url: target.url });
  }
}

const server = createServer({ config, db, metrics, scheduler, logger });

server.listen(config.port, config.host, () => {
  logger.info("server listening", { host: config.host, port: config.port, db: config.dbPath });
});

scheduler.start();

const pruneTimer = setInterval(() => {
  const cutoff = new Date(Date.now() - config.retentionDays * 86_400_000).toISOString();
  const removed = db.pruneChecks(cutoff);
  if (removed > 0) logger.info("pruned old checks", { removed, retentionDays: config.retentionDays });
}, 3_600_000);
pruneTimer.unref();

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutdown started", { signal });

  clearInterval(pruneTimer);
  await scheduler.stop();

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    setTimeout(resolve, 5000).unref();
  });

  db.close();
  logger.info("shutdown complete", { signal });
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  logger.error("unhandled rejection", { err: reason });
});
process.on("uncaughtException", (error) => {
  logger.error("uncaught exception", { err: error });
  void shutdown("uncaughtException");
});
