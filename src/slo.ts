export type SloStatus = "no_data" | "healthy" | "at_risk" | "breached";

export type SloSummary = {
  window: string;
  sloTarget: number;
  totalChecks: number;
  failedChecks: number;
  availability: number | null;
  /** Remaining error budget as a fraction (0..1). */
  budgetRemaining: number | null;
  /** Error budget burn rate (1 = burning exactly as fast as allowed). */
  burnRate: number | null;
  status: SloStatus;
};

export type CheckLike = { ok: boolean };

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

/**
 * Availability SLO maths.
 *
 * allowedFailureRate = 1 - sloTarget
 * burnRate           = observedFailureRate / allowedFailureRate
 * budgetRemaining    = 1 - burnRate  (clamped to 0..1)
 */
export function summarizeSlo(checks: readonly CheckLike[], sloTarget: number, window = "24h"): SloSummary {
  const totalChecks = checks.length;
  const failedChecks = checks.reduce((count, check) => (check.ok ? count : count + 1), 0);

  if (totalChecks === 0) {
    return {
      window,
      sloTarget,
      totalChecks: 0,
      failedChecks: 0,
      availability: null,
      budgetRemaining: null,
      burnRate: null,
      status: "no_data",
    };
  }

  const availability = (totalChecks - failedChecks) / totalChecks;
  const allowedFailureRate = Math.max(1 - sloTarget, 1e-9);
  const observedFailureRate = failedChecks / totalChecks;
  const burnRate = observedFailureRate / allowedFailureRate;
  const budgetRemaining = clamp(1 - burnRate, 0, 1);

  let status: SloStatus;
  const EPS = 1e-9;
  if (burnRate <= 0.5 + EPS) status = "healthy";
  else if (burnRate < 1 - EPS) status = "at_risk";
  else status = "breached";

  return {
    window,
    sloTarget,
    totalChecks,
    failedChecks,
    availability,
    budgetRemaining,
    burnRate,
    status,
  };
}

/** Converts a window expression such as "24h", "7d", "30m" into milliseconds. */
export function parseWindow(window: string, fallbackMs = 24 * 60 * 60 * 1000): number {
  const match = /^(\d+)([smhd])$/.exec(window.trim().toLowerCase());
  if (!match) return fallbackMs;
  const amount = Number.parseInt(match[1] ?? "0", 10);
  const unit = match[2];
  const multipliers: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const multiplier = multipliers[unit ?? ""];
  if (!Number.isFinite(amount) || amount <= 0 || multiplier === undefined) return fallbackMs;
  return amount * multiplier;
}

export function windowStartIso(window: string, now: number = Date.now()): string {
  return new Date(now - parseWindow(window)).toISOString();
}
