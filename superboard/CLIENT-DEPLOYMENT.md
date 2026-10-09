# Client agents — 2026-10-09

Provisioned using the existing credential-store SSH launchers in `client-cli/`,
following `client-cli/how-to-use.md`. No SSH passwords were requested, passed
via arguments/environment, or captured. The folder and ignore rules are unchanged.

| Launcher / monitor name | Monitor ID | Dashboard group |
|---|---:|---|
| aiel-qorgan | 46 | Aiel Qorgan |
| cmn | 47 | Ungrouped |
| modernization-meks | 48 | MEKS |
| national-business | 49 | nationalbusiness.kz |
| zhasalash | 50 | jasalash |

All five hosts are Linux x86_64. Agent 1.2.0 is installed persistently at
`/usr/local/bin/superboard`, enabled via root systemd service `superboard`.
The config is `/etc/superboard/config.json` (0600); its parent is 0700.
Push tokens are unique per monitor; the administrative API token is **not**
installed on any client host. Upload staging binaries were removed after install.

- Destination: `https://uptime.mediaboost.kz` with TLS verification enabled.
- CPU/RAM telemetry: 1 second; GPU: 5s; Docker: 10s; disk/temperatures: 30s.
- Host-down timeout: 180 seconds; existing default MBG Alerts assigned after
  successful ingestion. No deliberate host outage was induced to test delivery.
- All five reported Up with working Docker collection; three live SSE samples
  per new monitor were verified through the public endpoint.
- Website monitor `zhkhteam.kz` (51) added under MEKS at `https://zhkhteam.kz`,
  with 60-second checks/retries and existing MBG Alerts. It reported Up.
- Superboard card titles now use monitor names, preserving actual hostname
  in the title tooltip, so provider-generated numeric hostnames do not obscure
  these assigned names. The dashboard image was rebuilt/deployed; backend and
  client applications were not restarted for this presentation change.

Provisioning manifests/scripts with push credentials are held in Git/Docker-
ignored `private/client-agent-deployment/`, never in this document or `client-cli/`.
