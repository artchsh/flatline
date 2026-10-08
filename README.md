<div align="center" width="100%">
    <img src="./public/icon.svg" width="128" alt="Flatline Logo" />
</div>

# Flatline

Self-hosted uptime monitoring with Telegram alerts and an agent-friendly REST API.

A fork of [Uptime Kuma](https://github.com/louislam/uptime-kuma) (MIT), trimmed down to what a
small team actually uses and extended where it fell short. See [FORK-ROADMAP.md](./FORK-ROADMAP.md)
for the full list of changes.

## What is different from upstream

- **Telegram only.** All 108 other notification providers were removed, along with the Webpush
  service worker and its VAPID infrastructure. Fewer moving parts, one way to be paged.
- **Multiple real users.** Upstream supports several accounts but they cannot be created after
  setup. Flatline adds admin-issued, single-use invite links: mint a link, send it over any channel
  you already trust, the recipient picks their own password. No email required, no signup form.
- **REST API v1.** Everything the dashboard does is available over HTTP with bearer-token
  auth and per-token `read` / `write` / `publish` scopes, so scripts and LLM agents can drive it.
  `GET /api/v1/openapi.json` documents itself.
- **Shared instance.** There are no per-user silos: every operator sees and edits the same
  monitors, notifications and maintenance windows. Multiple accounts exist so panel access
  can be shared without passing around one password. Tokens and invite links stay per-user
  as the audit trail.
- **Flatline branding.** Hot-orange accent on warm near-black, following the palette of
  [1410666.xyz](https://1410666.xyz).

Upstream keeps everything it has: HTTP(s)/TCP/DNS/Ping/Push/Steam/Docker/SFTP/NTP/Postgres/Redis
and more monitor types, status pages, maintenance windows, proxy support, 2FA, and the ping charts.

## ⭐ Features

- Monitoring for HTTP(s), TCP, HTTP(s) Keyword, HTTP(s) Json Query, Websocket, Ping, DNS Record,
  Push, Steam Game Server, Docker Containers, gRPC, MQTT, PostgreSQL, MySQL, MS SQL, MongoDB,
  Redis, RabbitMQ, Kafka, SFTP, NTP, Oracle DB and more
- Telegram notifications with templates and MarkdownV2
- REST API v1 with token scopes and a self-describing OpenAPI document
- Multi-user with single-use invite links
- Multiple status pages, maintenance windows, tags, proxy support, 2FA
- 20-second intervals

## Architecture

Three processes, one backend:

| App | Dir | Port | What |
|---|---|---|---|
| Backend (API only) | `server/` | 3001 | Monitors, checks, notifications, REST v1. Serves JSON, no HTML. |
| Public status site | `apps/status-site` | 3002 | Per-client status pages (Next.js). |
| Operator dashboard | `apps/dashboard` | 3003 | Dense monitor table, Superboard, users (Vite + React). |

The dashboard and status site talk to the backend over HTTP with bearer
tokens. Sign in with a username and password; the dashboard mints a token for
the browser. Agents use `POST /api/v1/api-keys` (or the dashboard's Agents
panel) for theirs.

## 🔧 How to Install

### Local dev

Requires Node.js >= 26.2.0.

```bash
git clone https://github.com/artchsh/flatline.git
cd flatline
npm ci
./dev.sh
```

`./dev.sh` starts all three servers and seeds a demo database on first run.
Open the dashboard (address printed by the script) and sign in — on a fresh
database it asks you to create the first operator account. `./dev.sh stop`
stops everything; `./dev.sh status` checks health.

### 🐳 Docker

```bash
mkdir flatline && cd flatline
curl -O https://raw.githubusercontent.com/artchsh/flatline/master/compose.yaml
docker compose up -d --build
```

This starts all three services: the API on **3001**, the dashboard on **3003**,
the status site on **3002**. Data lives in `./data`. On first run, open the
dashboard and create the operator account — no token pasting, no seed scripts.

Browsers reach the backend at `BACKEND_URL` (default `http://127.0.0.1:3001`;
`localhost` fails in some browsers over IPv6). Set it to the LAN host or
public origin when the browser is elsewhere:

```bash
BACKEND_URL=http://192.168.1.10:3001 docker compose up -d --build
```

Behind a reverse proxy, serve all three from one origin instead: the status
page unlock posts cross-origin otherwise, and the browser will not keep the
unlock cookie.

### 🐳 Docker Command

Backend only (the frontends have their own images — see `docker/`):

```bash
docker run -d \
  --restart=always \
  -p 3001:3001 \
  -v flatline:/app/data \
  --name flatline \
  artchsh/flatline:1
```

### 💪🏻 Non-Docker

Requires Node.js >= 26.2.0.

```bash
git clone https://github.com/artchsh/flatline.git
cd flatline
npm ci
npm run start-server-dev
```

Then run the frontend apps (each has its own README): `apps/status-site`
and `apps/dashboard`, pointed at the backend URL.

Data is stored in `./data` (SQLite by default).

## 🔌 Quick start with the API

Create a token in the dashboard's **Agents** panel, optionally scoped to `read` only. Tokens are shown
once.

```bash
# What is broken right now?
curl -H "Authorization: Bearer uk1_..." http://localhost:3001/api/v1/health

# Create a monitor
curl -X POST http://localhost:3001/api/v1/monitors \
  -H "Authorization: Bearer uk1_..." \
  -H "Content-Type: application/json" \
  -d '{"name":"My API","type":"http","url":"https://example.com"}'

# Let an agent report its own check results
curl -X POST http://localhost:3001/api/v1/monitors/1/heartbeat \
  -H "Authorization: Bearer uk1_..." \
  -H "Content-Type: application/json" \
  -d '{"status":"up","ping":123}'
```

Point an agent at `http://localhost:3001/api/v1/openapi.json` and it can figure out the rest.

## 🆙 How to Update

```bash
docker compose pull && docker compose up -d
```

## 📜 Credits & licence

Built on [Uptime Kuma](https://github.com/louislam/uptime-kuma) by Louis Lam, MIT licensed.
This fork is released under the same licence; see [LICENSE](./LICENSE), which retains his
copyright notice.

Upstream project: <https://github.com/louislam/uptime-kuma>