import type { Db, Target } from "./db.ts";
import type { Logger } from "./logger.ts";
import type { Metrics } from "./metrics.ts";
import { probe } from "./probes.ts";

export type SchedulerOptions = {
  db: Db;
  metrics: Metrics;
  logger: Logger;
  concurrency?: number;
  failureThreshold?: number;
  /** Injected in tests to avoid real network calls. */
  probeFn?: typeof probe;
  /** Injected in tests. */
  randomFn?: () => number;
};

type Pending = () => void;

/**
 * Interval based probe runner.
 *
 * Design notes:
 * - one timer per target, with ±10% jitter so 500 targets never stampede together
 * - a bounded semaphore keeps in-flight probes <= concurrency
 * - a run is skipped (not queued) if the previous one is still active
 * - never throws: every failure is recorded and reported as a metric
 */
export class Scheduler {
  readonly #db: Db;
  readonly #metrics: Metrics;
  readonly #logger: Logger;
  readonly #concurrency: number;
  readonly #failureThreshold: number;
  readonly #probeFn: typeof probe;
  readonly #randomFn: () => number;

  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #inFlight = new Set<string>();
  readonly #queue: Pending[] = [];

  #active = 0;
  #stopped = false;

  constructor(options: SchedulerOptions) {
    this.#db = options.db;
    this.#metrics = options.metrics;
    this.#logger = options.logger.child({ component: "scheduler" });
    this.#concurrency = Math.max(1, options.concurrency ?? 8);
    this.#failureThreshold = Math.max(1, options.failureThreshold ?? 3);
    this.#probeFn = options.probeFn ?? probe;
    this.#randomFn = options.randomFn ?? Math.random;
  }

  get isRunning(): boolean {
    return !this.#stopped;
  }

  /** Schedules every enabled target. Safe to call more than once. */
  start(): void {
    if (this.#stopped) return;
    for (const target of this.#db.listTargets()) {
      if (target.enabled) this.schedule(target);
    }
    this.#logger.info("scheduler started", { targets: this.#timers.size, concurrency: this.#concurrency });
  }

  schedule(target: Target): void {
    if (this.#stopped) return;
    this.unschedule(target.id);
    this.#inFlight.delete(target.id);

    const intervalMs = Math.max(10, target.intervalSeconds) * 1000;
    const jitter = 0.9 + this.#randomFn() * 0.2;
    const delay = Math.max(1000, Math.round(intervalMs * jitter));

    // First probe almost immediately, then on the jittered interval.
    const firstTick = setTimeout(() => {
      void this.runOnce(target.id);
      this.#timers.set(target.id, this.#loop(target.id, intervalMs));
    }, Math.round(500 + this.#randomFn() * 1500));
    firstTick.unref();
    this.#timers.set(target.id, firstTick);
    this.#logger.debug("target scheduled", { target: target.name, delayMs: delay, intervalMs });
  }

  unschedule(targetId: string): void {
    const timer = this.#timers.get(targetId);
    if (timer) clearTimeout(timer);
    this.#timers.delete(targetId);
  }

  /** Stops all timers and waits for in-flight probes to settle. */
  async stop(): Promise<void> {
    this.#stopped = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#queue.length = 0;
    const deadline = Date.now() + 5000;
    while (this.#active > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    this.#logger.info("scheduler stopped", { active: this.#active });
  }

  #loop(targetId: string, intervalMs: number): NodeJS.Timeout {
    const timer = setTimeout(() => {
      void this.runOnce(targetId);
      if (!this.#stopped && this.#timers.has(targetId)) {
        this.#timers.set(targetId, this.#loop(targetId, intervalMs));
      }
    }, intervalMs);
    timer.unref();
    return timer;
  }

  async #acquire(): Promise<void> {
    if (this.#active < this.#concurrency) {
      this.#active += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.#queue.push(() => {
        this.#active += 1;
        resolve();
      });
    });
  }

  #release(): void {
    this.#active = Math.max(0, this.#active - 1);
    const next = this.#queue.shift();
    if (next) next();
  }

  /** Runs one probe for a target. Returns the stored check, or null if skipped. */
  async runOnce(targetId: string): Promise<{ ok: boolean; latencyMs: number } | null> {
    const target = this.#db.getTarget(targetId);
    if (!target || this.#stopped) return null;
    if (this.#inFlight.has(targetId)) {
      this.#logger.debug("probe skipped, previous still in flight", { target: target.name });
      return null;
    }

    this.#inFlight.add(targetId);
    await this.#acquire();

    try {
      const result = await this.#probeFn({
        url: target.url,
        timeoutMs: target.timeoutMs,
        expectedStatus: target.expectedStatus,
      });

      this.#db.recordCheck({
        targetId: target.id,
        ok: result.ok,
        statusCode: result.statusCode,
        latencyMs: result.latencyMs,
        error: result.error,
        checkedAt: result.checkedAt,
      });

      const labels = { target: target.name, url: target.url };
      this.#metrics.inc("sentinel_checks_total", "Total probes executed", { ...labels, result: result.ok ? "ok" : "fail" });
      this.#metrics.observe("sentinel_probe_duration_seconds", "Probe latency in seconds", result.latencyMs / 1000, labels);
      this.#metrics.setGauge("sentinel_target_up", "1 when the last probe succeeded", result.ok ? 1 : 0, labels);
      this.#metrics.setGauge("sentinel_target_latency_ms", "Latency of the last probe in milliseconds", result.latencyMs, labels);

      this.#trackIncident(target, result.ok, result.error);

      if (result.ok) {
        this.#logger.debug("probe ok", { target: target.name, status: result.statusCode, latencyMs: result.latencyMs });
      } else {
        this.#logger.warn("probe failed", { target: target.name, error: result.error, latencyMs: result.latencyMs });
      }

      return { ok: result.ok, latencyMs: result.latencyMs };
    } catch (error) {
      this.#logger.error("probe crashed", { target: target.name, err: error });
      return null;
    } finally {
      this.#inFlight.delete(targetId);
      this.#release();
    }
  }

  #trackIncident(target: Target, ok: boolean, error: string | null): void {
    if (ok) {
      const open = this.#db.openIncidentFor(target.id);
      if (open) {
        this.#db.resolveIncident(open.id);
        this.#metrics.inc("sentinel_incidents_resolved_total", "Incidents resolved");
        this.#logger.info("incident resolved", { target: target.name, incidentId: open.id });
      }
      this.#metrics.setGauge("sentinel_incidents_open", "Currently open incidents", this.#db.countOpenIncidents());
      return;
    }

    const failures = this.#db.consecutiveFailures(target.id);
    this.#metrics.setGauge("sentinel_consecutive_failures", "Trailing consecutive failed probes", failures, {
      target: target.name,
    });

    if (failures < this.#failureThreshold) return;

    const open = this.#db.openIncidentFor(target.id);
    if (open) {
      this.#db.bumpIncident(open.id, failures);
      return;
    }

    const incident = this.#db.openIncident(target.id, error ?? "probe failed", failures);
    this.#metrics.inc("sentinel_incidents_opened_total", "Incidents opened");
    this.#metrics.setGauge("sentinel_incidents_open", "Currently open incidents", this.#db.countOpenIncidents());
    this.#logger.error("incident opened", {
      target: target.name,
      incidentId: incident.id,
      failures,
      error,
    });
  }
}
