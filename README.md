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
- **REST API v1.** Everything the UI does over Socket.IO is available over HTTP with bearer-token
  auth and per-token `read` / `write` scopes, so scripts and LLM agents can drive it.
  `GET /api/v1/openapi.json` documents itself.
- **Per-user ownership enforced.** Upstream trusts whatever id the browser sends; several socket
  handlers would let any logged-in user read or delete another user's monitors. Every such path is
  now guarded.
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
- [80+ languages](./src/lang)

## 🔧 How to Install

### 🐳 Docker Compose

```bash
mkdir flatline && cd flatline
docker compose up -d
```

Or use the example file directly:

```bash
mkdir flatline && cd flatline
curl -O https://raw.githubusercontent.com/artchsh/flatline/master/compose.yaml
docker compose up -d
```

Flatline listens on port **3001** by default. Open <http://localhost:3001> and create the first
user.

### 🐳 Docker Command

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
npm run build

# Try it
npm run start-server-dev

# (Recommended) Run in the background
npm install -g pm2
pm2 start npm --name flatline -- run start
pm2 save
```

Data is stored in `./data` (SQLite by default).

## 🔌 Quick start with the API

Create a token under **Settings → API Keys**, optionally scoped to `read` only. Tokens are shown
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