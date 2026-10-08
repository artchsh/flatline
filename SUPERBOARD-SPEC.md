# Flatline — Superboard

Spec for fleet monitoring: a tiny Go agent on each client server pushes system
metrics to Flatline, and a fullscreen NOC-style board shows every client at a
glance. Built for the wall monitor, not the desk: the operator should be able
to see from across the room why a server has high load — or just enjoy looking
at it.

Status: **shipped — Phases 1–4.** See "As built" at the end of each phase for
the differences between this design and the code.

---

## Decisions locked

| Decision | Choice |
|---|---|
| Transport | Push only (outbound from client). No inbound ports, no client IPs in Flatline config, works behind NAT |
| Credential | Existing per-monitor `push_token`. No login, no user management on client boxes |
| Alerts v1 | Host-down only, through the existing push-timeout path. No threshold alerts |
| Containers v1 | List + healthy/up + exposed ports. No per-container CPU/mem |
| Editing | In the admin panel (where monitors are managed). The board itself is read-only |
| Board access | Separate page, auth-only (bearer token, same as the dashboard) |
| Board behaviour | Fullscreen, auto-paginating every ~5s (configurable) |
| Agent platform | Go, single static binary, linux/amd64, systemd install |

### Found while spec'ing

Push monitors already go DOWN with "No heartbeat in the time window" when no
push arrives within `interval + 1s buffer` (`server/model/monitor.js`, the push
branch of the check loop). The existing notification path fires from there, so
**host-down alerting is already built** — the agent just has to push regularly
and silence does the rest. No new alerting code for v1.

---

## Phase 1 — Ingest (backend)

### 1.1 `monitor_metric` table

```sql
-- monitor_metric
id            INTEGER PRIMARY KEY
monitor_id    INTEGER NOT NULL REFERENCES monitor(id) ON DELETE CASCADE
time          DATETIME NOT NULL
payload       TEXT NOT NULL  -- JSON, schema below
```

Rules, same as the rest of the repo: knex methods, no native SQL. Index on
`(monitor_id, time)`. No FK games: cascade delete is correct here, unlike
`source_group_monitor_id` — metrics for a deleted monitor are meaningless.

Migration: `db/knex_migrations/2026-10-0X-0000-monitor-metric.js`
(validate filename date at write time against existing migrations).

### 1.2 Payload schema (versioned)

```json
{
    "v": 1,
    "host": { "hostname": "client-a-db-01", "os": "linux", "uptime": 864001 },
    "cpu": { "percent": 23.5, "cores": 8 },
    "mem": { "total": 33554432, "used": 12582912, "percent": 37.5 },
    "disk": [ { "mount": "/", "total": 100, "used": 42, "percent": 42.0 } ],
    "gpu": { "available": false },
    "docker": [
        { "name": "api", "image": "api:1.4.2", "state": "running", "health": "healthy", "ports": [ "8080:80" ] }
    ]
}
```

Notes:
- Units are documented once, here: bytes for memory/disk totals, percent 0–100,
  uptime seconds. The agent and the board must never disagree about units.
- `gpu.available: false` is explicit, never absent: "no GPU" and "collector
  broken" must be distinguishable or you will chase ghosts.
- Disk is an array (root plus any data mounts); the agent sends every local
  mount it can read, the board shows the fullest first.
- `docker` is an empty array when Docker is absent, not null, for the same reason.
- `v: 1` so a future agent can add fields without breaking old readers. Unknown
  fields are ignored, never rejected.

### 1.3 Extend `/api/push/:pushToken`

Accept an optional JSON body alongside the existing query params:

```json
{ "status": "up", "ping": 12, "msg": "OK", "metrics": { ... } }
```

- Fully backwards compatible: query-param pushes behave exactly as today, and a
  body without `metrics` is today's request.
- `metrics` is validated for shape (object, under 64KB) and stored as-is. The
  server does not interpret it in v1 — no thresholds, no derived statuses.
- A push carrying metrics still counts as a heartbeat for the down-timeout, so
  one request keeps both "host up" and "here are the numbers" alive.
- Oversized or malformed `metrics` → 400, but the heartbeat itself is still
  recorded. A broken collector must never read as a dead host.

### 1.4 Retention

- Raw minute-resolution samples kept **30 days**, then pruned.
- Prune runs with the existing background-job pattern (hourly, unref'd timer).
- At the expected scale (10 clients × 1440 samples/day) 30 days is ~430k small
  rows — comfortable for SQLite, but the job ships with v1, not "later."

---

## Phase 2 — Agent (Go)

Single static binary (`CGO_ENABLED=0`), linux/amd64. No runtime dependencies.

### Collectors

| Source | What | Notes |
|---|---|---|
| `gopsutil/cpu` | percent, cores | 1s sample window per loop, not instantaneous |
| `gopsutil/mem` | total/used/percent | bytes, per the schema |
| `gopsutil/disk` | per-mount total/used/percent | every local mount it can read |
| `gopsutil/host` | hostname, os, uptime | |
| Docker socket | containers: name, image, state, health, ports | list + inspect; **no stats streaming in v1** |
| `nvidia-smi` | util, mem, temp if present | exec + parse, best-effort; failure → `available: false`, never fatal |

### Behaviour

- Loop every 60s (flag-configurable). Jitter ±5s so ten agents do not thunder.
- Push failure retries with backoff, then waits for the next tick. A failed push
  is *not* reported as host-down locally — silence is the signal, and the
  server already turns silence into an alert.
- Config file (`/etc/superboard/config.json`, mode 0600): server URL + push
  token. Token rotation = regenerate server-side, replace one line, restart.
- `superboard install`: writes the systemd unit, daemon-reloads, enables and
  starts. `superboard uninstall` removes all three. Refuses to double-install.
- `superboard check`: one collection + one push to stdout, exit code tells you
  if the server accepted it. For provisioning and debugging without journald.

### Explicitly out of v1

Per-container CPU/mem (stats streaming), threshold evaluation client-side,
log shipping, anything that is not "collect these six things and POST them."

---

## Phase 3 — Read API

Token-authed (bearer, same as the dashboard), alongside the existing v1 routers.

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/monitors/:id/metrics/latest` | read | Most recent sample, or 404 when none yet |
| `GET` | `/api/v1/monitors/:id/metrics?hours=24` | read | Windowed history, newest first, capped (suggest 1000 rows) |

- `hours` defaults to 24, max 168 (7d). Older than retention → whatever survives.
- Response shape is the stored payload plus `time`; the server does not reshape it.
- CORS: same `api-cors.js` middleware as the rest of v1, so the browser board can read it.

### As built

- `latest` orders by `time DESC, id DESC`, not `id DESC`: insertion order and
  time order diverge when samples arrive late, and the first version returned a
  stale row because of it. History orders the same way.
- Unreadable rows are skipped rather than failing the window: one corrupt
  payload degrades one sample, not the whole response.
- History is hard-capped at 1000 rows with a `capped` flag, independent of the
  `hours` window.
- `monitorToJSON` now also returns `weight` and `parent`. The board needs them
  to reproduce the operator's intended order, and they are harmless layout
  metadata. This is the only change to an existing endpoint in the phase.

---

## Phase 4 — Superboard page

A route in the dashboard app (auth-only via the existing token gate), visually
distinct from the dense table: this is the NOC wall, not the operator desk.

### Layout

- One card per server (one card per monitor with metrics; group monitors excluded).
- Each card: hostname, status pill, CPU / RAM / fullest-disk bars with numbers,
  container count with unhealthy highlighted, last-seen age.
- Bars are width + number, never colour alone — same rule as everywhere else.
- Fullscreen-friendly: no header chrome in kiosk mode (`?kiosk=1` hides the nav),
  large type, high contrast, works at Full HD and 4K@150%.

### Auto-pagination

- Pages of N cards (fit to viewport, default 6–8), rotating every **5s**
  (configurable via query param, e.g. `?rotate=5`).
- Rotation pauses on any interaction (click/keypress) and resumes after 30s idle,
  so touching it to investigate does not fight you.
- With few enough servers to fit, no rotation happens at all — no empty pages.
- A progress indicator shows position ("2 / 3") so the rotation is legible, not
  disorienting.

### Editing (in the admin panel, not on the board)

- Pairing lives in the monitor edit flow: generate/rotate the push token, set
  the expected interval, link the monitor to its client group.
- The Superboard itself is read-only. No controls except rotation pause.
- What "editable" means concretely: which servers appear (any monitor with a
  recent metrics sample), card order (follow group weight, then name), and the
  rotate interval. All three are board settings, not per-card controls.

### As built

- Routes live in the dashboard app: `/superboard` (with chrome) and
  `/superboard/kiosk` (no chrome, fixed viewport, no scrollbar). A ~40-line
  path router in `src/lib/router.ts`; no routing dependency.
- Discovery is the 404: the board lists monitors, skips `type: "group"`, and
  calls `metrics/latest` for the rest. A 404 means "not a server" and is
  dropped. Zero configuration, and a server that stops pushing ages out on its
  own.
- Card order: parent group `weight`, then the monitor's own `weight`, then
  name. Name is the tie-breaker so the board never reshuffles between
  refreshes.
- Page size is measured, not hard-coded: the board computes columns × rows from
  its own box against a 340×220 minimum and re-measures on resize, so Full HD
  and 4K@150% both fill sensibly. `?perPage=N` overrides; `?rotate=SECONDS`
  sets the rotation interval (default 5, clamped 1–300).
- Rotation pauses on any pointer, key or touch interaction and resumes after
  30s idle. It also pauses while the tab is hidden. With everything fitting on
  one page there is no rotation at all.
- The first fetch always runs even if the tab is hidden at mount; only the
  polling interval skips hidden ticks. Without that, a kiosk woken from the
  background flashes "no servers".
- A sample older than two intervals dims the card and shows "stale" rather than
  silently presenting old numbers as current.

---

## Sequencing and risks

1. Migration + ingest extension (shippable, testable with curl)
2. Go agent (testable against the above with `superboard check`)
3. Read API
4. Superboard page

| Risk | Mitigation |
|---|---|
| DB grows unbounded | Prune job ships in the same commit as the table |
| Agent version skews payload shape | `v: 1` envelope; server ignores unknown fields |
| A broken collector reads as a dead host | Malformed metrics 400s but the heartbeat is still recorded |
| Push token leaks from a client box | 0600 config; rotation is one server-side regenerate + one line |
| Plain HTTP on the wire | Document TLS requirement; the agent refuses plain HTTP unless explicitly allowed |
| nvidia-smi parsing breaks on a new driver | Best-effort by contract; failure yields `available: false`, never a crash |
| Board overwhelms at 10+ clients | Auto-pagination is the design, not a fallback; verify at 4K before calling it done |

## Resolved

| Question | Decision |
|---|---|
| Retention | **30 days raw**, prune job ships with the table. Revisit only at 10x scale |
| Non-systemd boxes | **cron `@reboot` fallback** with a logged warning. systemd when present; never a silent half-install |
| Kiosk param vs route | **Dedicated route.** `/superboard` (with nav) and `/superboard/kiosk` (chrome-free, memorable wall URL) |
