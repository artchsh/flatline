# Contributing

Flatline is a personal fork maintained by one person and merged straight to `main`. There is no
PR process and no CI.

## Ground rules

- **Understand every line you merge.** This codebase is a fork of
  [Uptime Kuma](https://github.com/louislam/uptime-kuma) with a large amount of local change.
  Half-understood patches are worse than no patch.
- **Test before you commit.** There is no automated gate:

  ```bash
  npm ci
  npm run lint
  npm run build
  npm run test-backend
  ```

- **Manual checks that matter for this fork:**

  | Area | How to verify |
  |---|---|
  | Telegram | Settings → Notifications → send a test; trigger a real down alert |
  | Invite links | mint → redeem in a private window → confirm a second attempt fails |
  | REST API | `GET /api/v1/health` with a scoped token; confirm a `read`-only token gets `403` on writes |
  | Multi-user isolation | create two users; confirm neither can reach the other's monitors |
  | UI | load the dashboard light and dark, and the status page |

## Keeping the fork mergeable

`FORK-ROADMAP.md` lists every intentional divergence from upstream. If you pull upstream changes:

- re-check the sections that say "verified" before assuming they still hold
- `server/monitor-service.js` deliberately replaced the inline monitor logic in `server.js`;
  upstream edits to those handlers will conflict
- the Telegram-only removal means upstream notification work will conflict wholesale
- run the manual table above, not just the automated tests

## Style

Follow the surrounding code: ES modules or CommonJS as the file already uses, Vue 3 Options API,
4-space indent, JSDoc on exported functions. `npm run lint` enforces this.

## Licence

MIT, same as upstream. See [LICENSE](./LICENSE).