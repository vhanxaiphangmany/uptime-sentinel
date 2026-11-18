# uptime-sentinel

Zero-dependency uptime monitor with a production-grade delivery pipeline (CI/CD, Docker, Kubernetes, Helm, SLO alerting).

## What it is

`uptime-sentinel` is a small HTTP service that:

- polls HTTP(S) targets on an interval (with ±10% jitter) through a concurrency-bounded scheduler
- records every probe (latency, status code, ok/fail) in SQLite via `node:sqlite`
- exposes a Prometheus text-format registry at `/metrics` (no client library required)
- exposes a web status page at `/` and a JSON API at `/api/*`
- tracks error-budget burn rate and opens/resolves incidents automatically
- serves `/healthz` and `/readyz` for Kubernetes, and a retention-pruned check history

There are **no runtime dependencies**. The service only uses the Node.js standard library (HTTP, SQLite, crypto, timers, Web Fetch, Web streams). Node ≥ 22.6 is required for built-in TypeScript type stripping.

## Quick start

```bash
# from the repo root
node src/main.ts
```

Environment variables (all optional except seeding/ops use):

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | bind host |
| `PORT` | `8080` | bind port |
| `DB_PATH` | `./data/sentinel.db` | SQLite file path (or `:memory:`) |
| `SEED_TARGETS` | (none) | `name=url,name=url` seeded on first run when DB is empty |
| `ADMIN_TOKEN` | (none) | when set, ≥ 8 chars; enables `Authorization: Bearer <token>` for mutating routes |
| `PROBE_CONCURRENCY` | `8` | max in-flight probes |
| `FAILURE_THRESHOLD` | `3` | consecutive failures before an incident opens |
| `DEFAULT_TIMEOUT_MS` | `5000` | default probe timeout |
| `DEFAULT_INTERVAL_SECONDS` | `60` | default probe interval |
| `RETENTION_DAYS` | `14` | checks older than this are pruned hourly |
| `SLO_TARGET` | `0.999` | availability target (e.g. 0.999 = 99.9%) |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `APP_VERSION` | `dev` | reported by `/metrics` and `/api/version` |
| `NODE_ENV` | `development` | `production` / `staging` etc. |

Example:

```bash
SEED_TARGETS="API=https://api.example.com/healthz,Website=https://example.com" \
ADMIN_TOKEN="change-me-to-a-long-secret" \
node src/main.ts
```

Then open `http://localhost:8080/` for the status page.

## API

```text
GET    /healthz                      liveness (200 OK)
GET    /readyz                       readiness (200 / 503)  DB + scheduler must be healthy
GET    /metrics                      Prometheus text format (0.0.4)
GET    /                             HTML status page (auto-refresh 30s)
GET    /api/version                  { name, version, env, node }
GET    /api/targets                  list targets with view models
POST   /api/targets                  create target (admin token required)
DELETE /api/targets/:id              delete target (admin token required)
GET    /api/targets/:id              target detail
GET    /api/targets/:id/checks?limit=  recent checks
POST   /api/targets/:id/check        trigger one manual check (admin token required)
GET    /api/incidents?limit=         list incidents
GET    /api/slo?window=24h           SLO summary per target (burn rate, budget remaining)
```

`Authorization: Bearer <ADMIN_TOKEN>` is required for all mutating routes (POST/DELETE). Read routes and operational endpoints are unauthenticated.

### Target schema (POST /api/targets)

```json
{
  "name": "Example App",
  "url": "https://app.example.com/healthz",
  "intervalSeconds": 60,
  "timeoutMs": 5000,
  "expectedStatus": "200-299"
}
```

`expectedStatus` supports `200-299`, `200,301,302`, `*`, or a single status code such as `200`.

## Operational behavior

### Probes

Each target is scheduled with a ±10% jitter around `intervalSeconds`. A bounded semaphore caps in-flight probes at `PROBE_CONCURRENCY`. A probe is skipped (not queued) if the previous one is still running. Transport errors are recorded as failures, never thrown.

### Incidents

- `FAILURE_THRESHOLD` consecutive failed probes opens an incident (one per target).
- Subsequent failures bump `failedChecks`.
- The first successful probe resolves the incident.

### SLO math

`burnRate = observedFailureRate / (1 - SLO_TARGET)`. A `burnRate < 0.5` is `healthy`, `0.5..1` is `at_risk`, `>= 1` is `breached`. Budget remaining is `1 - burnRate`, clamped to `[0, 1]`.

### Metrics exposed

- `sentinel_checks_total{target,url,result}` — counter
- `sentinel_probe_duration_seconds{target,url}` — histogram (0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10s)
- `sentinel_target_up{target,url}` — gauge (1/0)
- `sentinel_target_latency_ms{target,url}` — gauge
- `sentinel_consecutive_failures{target}` — gauge
- `sentinel_incidents_open` / `sentinel_incidents_opened_total` / `sentinel_incidents_resolved_total`
- `sentinel_targets_total` / `sentinel_build_info{version,env}` / `sentinel_process_uptime_seconds`
- `sentinel_http_requests_total{method,path,status}`

## Testing

```bash
npm test              # node --test "test/*.test.ts"
npm run test:coverage
npm run typecheck     # requires devDependencies: npm.cmd install
```

All tests are hermetic: no network calls are made; the probe function is injected as a stub.

## Docker

```bash
docker build -t uptime-sentinel .
docker run -p 8080:8080 \
  -e ADMIN_TOKEN="change-me-to-a-long-secret" \
  -e SEED_TARGETS="API=https://api.example.com/healthz" \
  -e DB_PATH=/data/sentinel.db \
  -v sentinel_data:/data \
  uptime-sentinel
```

See [`Dockerfile`](Dockerfile) — it runs as a non-root user and uses a read-only dependency-free install.

## Kubernetes sketch

`k8s/` contains a minimal deployment + service + configmap + HPA. It is intentionally simple: no service mesh, no sidecars, one command to apply. See `k8s/README.md`.

## Design notes

- **No runtime dependencies.** We don't use Express, `prom-client`, or an ORM. This keeps the image tiny and the threat surface small. SQLite WAL mode handles concurrent readers/writers and survives crashes; `PRAGMA busy_timeout = 5000` covers transient lock contention.
- **Fail-open logging.** If `LOG_LEVEL=error` or `info`, the structured JSON logs go to stdout and are parseable by any log shipper.
- **One-time migrations.** The schema is applied idempotently on startup (`CREATE TABLE IF NOT EXISTS`), so restarts are safe.
- **Admin token is required for mutating routes.** In production you must set `ADMIN_TOKEN` (≥ 8 characters) for PATCH/POST/DELETE to work.
- **Retention.** `RETENTION_DAYS` controls how far back `/checks` data lives locally. Incident history is retained indefinitely.

## License

MIT. See `LICENSE` if present, otherwise see `package.json`.
