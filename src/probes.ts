export type ProbeSpec = {
  url: string;
  timeoutMs: number;
  /** "200-299" | "*" | "200,301,302" */
  expectedStatus: string;
};

export type ProbeResult = {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  error: string | null;
  checkedAt: string;
};

export type ProbeOptions = {
  fetchImpl?: typeof fetch;
  now?: () => number;
};

/** Evaluates an expected-status expression against an HTTP status code. */
export function statusMatches(expected: string, statusCode: number): boolean {
  const spec = expected.trim();
  if (spec === "" || spec === "*") return true;
  for (const part of spec.split(",")) {
    const token = part.trim();
    if (token === "") continue;
    const range = token.split("-");
    if (range.length === 2) {
      const low = Number.parseInt(range[0] ?? "", 10);
      const high = Number.parseInt(range[1] ?? "", 10);
      if (Number.isFinite(low) && Number.isFinite(high) && statusCode >= low && statusCode <= high) return true;
      continue;
    }
    const exact = Number.parseInt(token, 10);
    if (Number.isFinite(exact) && exact === statusCode) return true;
  }
  return false;
}

/** Validates a user supplied expected-status expression. */
export function isValidStatusSpec(expected: string): boolean {
  const spec = expected.trim();
  if (spec === "*" || spec === "") return true;
  return spec.split(",").every((part) => {
    const token = part.trim();
    if (token === "") return false;
    const range = token.split("-");
    if (range.length === 2) {
      const low = Number(range[0]);
      const high = Number(range[1]);
      return Number.isInteger(low) && Number.isInteger(high) && low >= 100 && high <= 599 && low <= high;
    }
    const exact = Number(token);
    return Number.isInteger(exact) && exact >= 100 && exact <= 599;
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "timeout";
    return error.message || error.name;
  }
  return String(error);
}

/**
 * Performs a single HTTP probe. Never throws: transport errors become
 * `ok: false` results so a dead endpoint can never crash the scheduler.
 */
export async function probe(spec: ProbeSpec, options: ProbeOptions = {}): Promise<ProbeResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const checkedAt = new Date(now()).toISOString();
  const startedAt = now();

  try {
    const response = await doFetch(spec.url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(spec.timeoutMs),
      headers: { "user-agent": "uptime-sentinel/1.x (+https://github.com)" },
    });
    const latencyMs = Math.round((now() - startedAt) * 100) / 100;
    // Drain the body so the socket can be reused / closed cleanly.
    await response.body?.cancel().catch(() => undefined);
    const statusCode = response.status;
    const ok = response.ok && statusMatches(spec.expectedStatus, statusCode);
    return {
      ok,
      statusCode,
      latencyMs,
      error: ok ? null : `unexpected status ${statusCode}`,
      checkedAt,
    };
  } catch (error) {
    const latencyMs = Math.round((now() - startedAt) * 100) / 100;
    return { ok: false, statusCode: null, latencyMs, error: errorMessage(error), checkedAt };
  }
}
