# Office deployment

Public origin: `https://uptime.mediaboost.kz`, existing Cloudflare Tunnel to
`http://localhost:3001`. Gateway routes `/api/` and `/upload/` to the backend,
`/status/` and `/_next/` to the status site, and other paths to the dashboard.
SSE buffering is disabled. Only the gateway is published.

The standalone `compose.production.yaml` is deployed as
`/home/office/flatline/compose.yaml` with `docker/production-gateway.conf` copied
alongside it. Uses office's rootless Docker daemon (not the empty root daemon).

Build all images for `linux/amd64` and transfer/load them on office:

```sh
docker build --platform linux/amd64 -f docker/dockerfile --target release -t artchsh/flatline:office-live .
docker build --platform linux/amd64 -f docker/dashboard.dockerfile -t artchsh/flatline-dashboard:office-live .
docker build --platform linux/amd64 -f docker/status-site.dockerfile --build-arg NEXT_PUBLIC_FLATLINE_URL=https://uptime.mediaboost.kz -t artchsh/flatline-status:office-live .
```

Stage on loopback port 3101. Do not replace the original Kuma data directory.
Use SQLite's backup API for a consistent copy of a running database. Keep all
DB files, backups, credentials, tunnel tokens and agent configs out of Git.
Before public access, rotate operator passwords, revoke development API keys,
and disable unwanted accounts. Agent push tokens are separate credentials.

For staging, detach notification links in the *copy* (notification `active=0`
alone does not mute upstream monitor delivery). Restore links and original
notification activation only after stopping other active monitoring backends.

Cutover requires stopping `uptime-kuma` to release port 3001, then setting
`FLATLINE_PORT=3001` in `.env` and recreating only the gateway. The original
container/image/data remain available for rollback. Agent configs must also
be redirected to office. Rootless Docker is enabled at boot with user linger.

Rollback (office, as user `office`):

```sh
cd /home/office/flatline
docker compose stop
docker start uptime-kuma
```

This restores the original public application without modifying either DB.
Restore saved pre-cutover agent configs separately if returning to the Mac
Flatline backend. Stop one monitoring backend before enabling another to avoid
duplicate alerts. Do not start the old Mac backend after production cutover
unless its notification links have first been disabled.

## Cutover record — 2026-10-09

- Office stack is deployed in `/home/office/flatline`, gateway on loopback 3001.
- Original `uptime-kuma` is stopped, not removed. Original data is unchanged.
  Its consistent backup is under `/home/office/flatline-backups/` (integrity OK).
- The Mac Flatline backend was stopped. Agents 43/44/45 now push over HTTPS
  to the public origin; all three were verified through the Cloudflare SSE
  stream. Office's agent binary was moved to `/usr/local/bin/superboard`.
- Production `skyler` password was rotated; 18 development API keys revoked.
  New credentials are stored locally in Git/Docker-ignored
  `private/office-production-login.txt` (0600), not in this document.
- Original 25 notification links were restored after cutover. One migration
  test was accepted by Telegram for MBG Alerts; recipient confirmation remains
  required. Agent monitors have no notification links: select their destination
  before claiming they have working host-down Telegram alerts.
- Public dashboard, `/status/clients`, logo, API authentication, and SSE checked.
- Dependency audit: 12 inherited production advisories (6 moderate, 4 high,
  2 critical). Review and remediate in a separate tested hardening pass; do not
  blindly run `npm audit fix --force` on the production stack.
