import test from "node:test";
import assert from "node:assert/strict";
import { isValidStatusSpec, probe, statusMatches } from "../src/probes.ts";

test("statusMatches understands ranges, lists and wildcards", () => {
  assert.equal(statusMatches("200-299", 204), true);
  assert.equal(statusMatches("200-299", 301), false);
  assert.equal(statusMatches("200,301,302", 301), true);
  assert.equal(statusMatches("200,301,302", 200), true);
  assert.equal(statusMatches("200", 200), true);
  assert.equal(statusMatches("*", 500), true);
  assert.equal(statusMatches("", 418), true);
});

test("isValidStatusSpec rejects nonsense", () => {
  assert.equal(isValidStatusSpec("200-299"), true);
  assert.equal(isValidStatusSpec("200,301"), true);
  assert.equal(isValidStatusSpec("*"), true);
  assert.equal(isValidStatusSpec("abc"), false);
  assert.equal(isValidStatusSpec("299-200"), false);
  assert.equal(isValidStatusSpec("99"), false);
  assert.equal(isValidStatusSpec("200,"), false);
});

test("probe reports a healthy response with latency", async () => {
  let clock = 0;
  const result = await probe(
    { url: "https://example.com", timeoutMs: 1000, expectedStatus: "200-299" },
    {
      now: () => clock,
      fetchImpl: (async () => {
        clock += 120;
        return new Response("ok", { status: 200 });
      }) as typeof fetch,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  assert.equal(result.latencyMs, 120);
  assert.equal(result.error, null);
  assert.equal(result.checkedAt, new Date(0).toISOString());
});

test("probe marks unexpected statuses as failures", async () => {
  const result = await probe(
    { url: "https://example.com", timeoutMs: 1000, expectedStatus: "200-299" },
    { fetchImpl: (async () => new Response("nope", { status: 503 })) as typeof fetch },
  );

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 503);
  assert.match(result.error ?? "", /unexpected status 503/);
});

test("probe never throws on transport errors", async () => {
  const result = await probe(
    { url: "https://nope.invalid", timeoutMs: 50, expectedStatus: "200-299" },
    {
      fetchImpl: (async () => {
        throw new TypeError("getaddrinfo ENOTFOUND nope.invalid");
      }) as typeof fetch,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, null);
  assert.match(result.error ?? "", /ENOTFOUND/);
});

test("probe normalises aborts into a timeout error", async () => {
  const result = await probe(
    { url: "https://slow.invalid", timeoutMs: 10, expectedStatus: "200-299" },
    {
      fetchImpl: (async () => {
        const error = new Error("The operation was aborted due to timeout");
        error.name = "TimeoutError";
        throw error;
      }) as typeof fetch,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "timeout");
});
