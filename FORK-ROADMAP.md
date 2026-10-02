# Flatline — Fork Roadmap

Personal fork of [Uptime Kuma](https://github.com/louislam/uptime-kuma) (MIT).
Upstream stays untouched; no PRs are sent back.

Upstream's contributor-policy and CI files were removed — this fork is solo-developed and
merges straight to `main`:

- `AGENTS.md`, `CLAUDE.md` (contributor policy / AI-slop warnings)
- `.github/workflows/` (all 21: PR checks, issue bots, CodeQL, Docker, releases)
- `.github/actions/setup-atlascloud`, `.github/config/` (only used by deleted workflows)
- `.github/ISSUE_TEMPLATE/`, `PULL_REQUEST_TEMPLATE.md`, `REVIEW_GUIDELINES.md`
- `.github/dependabot.yml` (only tracked GitHub Actions — now pointless)
- `.github/FUNDING.yml` (upstream's donation links)
- AI-slop warning in `.github/copilot-instructions.md`

`.github/` now holds just `copilot-instructions.md` and `opencode-models.json`.
**The underlying advice still stands:** understand every line before you ship it.
Run `npm run lint` and `npm test` locally — nothing enforces it for you anymore.

---

## Project goals

| Goal | Status |
|---|---|
| Rebrand to **Flatline** (cyberpunk theme) | Planned |
| Frontend rework (optional, maybe Next.js + shadcn) | Deferred / optional |
| Multi-user, no roles (admin-issued single-use invite links) | Planned |
| Telegram-only notifications | **Done** (needs manual test) |
| Agentic REST API with tokens | Planned |

### Rebrand scope

- [ ] Display name `Uptime Kuma` → `Flatline` (`src/util.ts:44`, `index.html`)
- [ ] npm package name in `package.json`
- [ ] Docker image refs (`package.json` scripts, `docker/*.dockerfile`, `compose.yaml`)
- [ ] Icons / logo (`public/`: `icon.svg`, `favicon.ico`, `apple-touch-icon.png`, `icon-192x192.png`, `icon-512x512.png`, `icon.png`, `manifest.json`)
- [ ] Console output (`server/server.js` "Welcome to...", `process.title`)
- [ ] Docs (`README.md`)
- [ ] Hardcoded upstream URLs (105 files reference the `uptime-kuma` slug)

Current counts: **144 files** contain "Uptime Kuma", **105 files** contain `uptime-kuma`.

Cyberpunk palette targets `src/assets/vars.scss` (`$primary: #5cdd8b` today).

**License:** keep MIT `LICENSE` + Louis Lam's copyright. Add own copyright alongside.
Never ship upstream's name/logo in the fork (the name is a separate trademark from the code).

### Frontend rework (deferred)

Deliberately **not** doing now. If revisited: keep the Express + Socket.IO backend and
build a separate Next.js frontend against it, rather than a full-stack rewrite.

Reasoning: shadcn/ui is React-only, so either path means rewriting all 182 components
(~35k LOC) plus ~2,861 Bootstrap class usages. Socket.IO is the realtime backbone, so a
full Next.js rewrite also forfeits serverless deploys. A frontend-only split is the
lower-risk path if this is ever picked up.

---

## Current stack (reference)

Vue 3 Options API · Vite 8 · Bootstrap 5 + SCSS · vue-router 4 · vue-i18n (81 locales) ·
Socket.IO · Express · redbean-node (ORM) · better-auth · 30k LOC backend / 35k LOC frontend

Notable: 182 `.vue` components, ~110 notification providers (backend + frontend each),
API is basic-auth + API-key only, Socket.IO drives nearly all mutations.

---

## Feature 1 — Multi-user (no roles)

### Findings

Multi-user **partially exists already**:

- `user` table with `username`, `password`, `role` (`db/knex_init_db.js:54`)
- better-auth with `admin()` plugin + `role` field (`server/better-auth.ts:7,88`)
- 47 `user_id` references across the server — data is already scoped per user
- Socket rooms are per-user (`io.to(monitor.user_id)`)

### Gaps

1. **`disableSignUp: true`** (`server/better-auth.ts:74`) — no second user can register.
2. No user-management UI. `Setup.vue` only creates the very first user.
3. **Role is effectively unused** — only ever set to `"admin"`, never checked.
   So "no roles" is already ~true; the work is enabling registration.
4. `/api/setup` needs an equivalent for adding users post-setup.

### Invite model — decided

**Admin-issued single-use magic link, no email.** The first user (admin) mints a link,
sends it to the other person over any channel they like (Slack, Signal, carrier
pigeon), and the recipient sets their own username + password. Link dies on use.

Deliberately not self-signup: this is a monitoring tool whose whole job is sending
outbound alerts. Open registration plus free-text Telegram targets is an open relay.

Design notes:

- Token is a high-entropy random string, **hashed at rest** (never store the plaintext),
  so a DB leak can't be replayed into account creation.
- Single use enforced **atomically** — consume-and-create in one transaction, so two
  simultaneous redemptions of the same link can't both succeed.
- Add an **expiry** (default 24h) and let the admin revoke outstanding links.
- Invitation is for *account creation only* — the user sets their own password, so
  there is no reset-email flow to build and no email infrastructure at all.
- `disableSignUp: true` stays **on**. Redemption uses an explicit
  `auth().api.createUser()` server-side call (same path `/api/setup` already uses),
  so public signup remains impossible.

### better-auth capability check (done — verdict: build custom)

Inspected `better-auth@1.6.11` directly. Results:

| Plugin / API | Verdict |
|---|---|
| `admin()` (already enabled) | **No invite support.** Surface is only `createUser`, `listUsers`, `setRole`, `banUser`, `removeUser`, `revokeUserSession`, `impersonateUser`. No `inviteUser`. |
| `magic-link` | **Wrong fit.** Email-keyed (needs an email address), creates the user *and* auto-logs them in via `createSession` + `setSessionCookie` — the invitee never sets a password, so the account ends up passwordless. Default expiry is only 5 min, and tokens default to `storeToken: "plain"`. |
| `one-time-token` | **Wrong direction.** Requires an existing session (`sessionMiddleware`) and mints a token *from* a logged-in user to bootstrap another device. That is "I'm logged in, give me a CLI token" — not "admin invites a stranger". |
| `organization` | Has invites, but requires an org and pulls in a large schema. Overkill for flat same-permission users. |

Conclusion: no built-in fit. Build the `user_invite` table, but **reuse `admin().api.createUser()`**
as the account-creation primitive — it is already enabled, already accepts a `password`, and
`/api/setup` uses it today, so username/2FA/email handling stays consistent with first-user setup.

Bonus: better-auth already solved one hard problem for free — magic-link token consumption is
atomic (`consumeVerificationValue`), and it supports `storeToken: "hashed"`. Worth copying that
shape (hash at rest, atomic consume) into our own implementation.

### Plan

- [ ] Migration: `user_invite` table (token hash, created_by, expires_at, used_at).
- [ ] Model `server/model/user_invite.js`: create / consume (atomic) / revoke / list.
- [ ] Socket handler `userSocketHandler.js`: admin-only
      `createUserInvite` / `getUserInviteList` / `revokeUserInvite`.
- [ ] Public route `POST /api/invite/redeem` (unauthenticated, rate-limited) —
      validates + consumes the token and creates the user in one transaction.
- [ ] Frontend: `/invite/:token` page (username + password), and a Settings →
      Users panel for the admin to mint/revoke links.
- [ ] Reuse the existing `/api/setup` user-creation path so 2FA/email/username
      handling stays identical to first-user setup.
- [ ] Confirm per-user isolation is complete (audit the 47 `user_id` call sites for
      unscoped queries — this is the real risk, not the role system).
- [ ] Drop the `role` column, or leave it inert and unused.
- [ ] Guard: last remaining admin must not be deletable/demotable.

---

## Feature 2 — Telegram-only notifications

### Findings

- **110** provider files in `server/notification-providers/`
- **~110** matching components in `src/components/notifications/`
- Registry: `server/notification.js` — ~110 `require()`s (lines 3–~115) plus a
  `new X()` list (lines 128–~230) inside `Notification.init()`
- Frontend registry: `src/components/notifications/index.js` (227 lines of imports/exports)
- Telegram already exists and works — **no new functionality needed**

### Risks

- **Existing rows.** Anyone with a non-Telegram notification in the DB will hit a
  missing-provider path. Needs an explicit decision, not silent breakage.
- Dependency cleanup is a separate pass — several deps exist only for specific
  providers (e.g. `@grpc/grpc-js`, `gamedig`, `kafkajs`, `oracledb`, `ssh2-sftp-client`).
  Do **not** touch these in the same change; verify each is unused first.
- i18n: ~110 providers have translated strings across 81 locale files. Don't mass-delete
  locale keys — leave them, they're inert.

### Plan — DONE

- [x] Deleted 108 non-Telegram server providers + 108 frontend components.
- [x] `server/notification.js`: single `Telegram` require, `list = [new Telegram()]`.
      Removed the Apprise-only `checkApprise()` and its now-unused `commandExists` import.
- [x] `src/components/notifications/index.js`: `{ telegram: Telegram }`.
- [x] `NotificationDialog.vue`: 9 category `<optgroup>`s collapsed to a flat `<option>`
      list; `notificationNameList` is now `{ telegram: "Telegram" }`.
      Removed `notificationFullNameList` (was only a category flattener) and repointed
      `getUniqueDefaultName()` at `notificationNameList`.
- [x] Removed `test-indigo.js` (tested a deleted provider). Kept
      `test-notification-provider.js` (tests the base class, still used by Telegram)
      and `test-ntlm.js` — **axios-ntlm is core monitor infrastructure**
      (`server/model/monitor.js` uses `httpNtlm`), not notification-only.
- [x] Orphaned DB rows: `Notification.send()` now throws a message naming the offending
      type and listing available providers, instead of a bare "not supported".
      Upstream already try/catches per-notification, so a stale row logs an error and
      never breaks the send loop for other notifications.
- [x] Removed `checkApprise` socket handler and the Apprise frontend keys.

**Webpush was removed too** — it is a notification provider like the rest, so keeping it
would have contradicted "Telegram only". That cascaded into:
- `public/serviceWorker.js` deleted, and its registration removed from `src/main.js`
- `getWebpushVapidPublicKey` socket handler + the `web-push` require removed from `server/server.js`
- npm deps `web-push` and `form-data` dropped from `package.json` (verified zero remaining refs)

Left alone deliberately: the ~81 `src/lang/*.json` files still carry `apprise*` and the
9 `notification*` category strings. They are inert, and hand-editing 81 locale files to
remove dead keys is a large diff for zero runtime benefit.

Dependency pruning beyond `web-push`/`form-data` is **not** done — `nodemailer`,
`gamedig`, `kafkajs`, `oracledb`, `ssh2-sftp-client`, `@grpc/grpc-js` etc. are still
referenced by monitor types and DB drivers. Verify each separately before touching.

### Manual verification still required

- [ ] `npm ci && npm run build` (needs Node >= 26.2.0 per `engines`)
- [ ] Create a Telegram notification in the UI and send a test
- [ ] Trigger a real down/up alert end to end
- [ ] If upgrading an existing DB that had other providers, confirm the stale-row error
      message appears and the rest still works

---

## Feature 3 — Agentic REST API with tokens

### Findings

Existing API surface is **almost entirely read-only badges**:

- `server/routers/api-router.js` (655 lines): `/api/entry-page`, `/api/push/:pushToken`,
  and ~7 badge endpoints (status / uptime / ping / avg-response / cert-exp / response)
- Auth: `apiAuth` middleware (`server/auth.js`) — HTTP Basic. API key as the password,
  else username+password. Rate-limited to ~60 req/min.
- API keys already exist: `api_key` table + `better_auth_apikey`, hashed keys formatted
  `uk<id>_<nanoid40>`, created via `addAPIKey` socket event (`api-key-socket-handler.js`)
- **Almost all mutations are Socket.IO only** — no REST equivalent for create/edit/delete

### Definition of "agentic"

For an LLM agent to drive this, it needs full CRUD over HTTP with a real token, not
socket-emit gymnastics. Suggested surface:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/monitors` | list (filterable) |
| `POST` | `/api/v1/monitors` | create |
| `GET` | `/api/v1/monitors/:id` | read, incl. status + uptime |
| `PATCH` | `/api/v1/monitors/:id` | update |
| `DELETE` | `/api/v1/monitors/:id` | delete |
| `GET` | `/api/v1/monitors/:id/heartbeats` | time series |
| `GET``POST` | `/api/v1/incidents` | list / create |
| `GET` | `/api/v1/status-pages` | list |
| `GET` | `/api/v1/maintenance` | list |
| `GET` | `/api/v1/tags` | list |

### Plan

- [ ] New `server/routers/api-v1-router.js`, mounted before the SPA catch-all.
- [ ] Real token auth: `Authorization: Bearer <token>` as the primary scheme.
      **Keep Basic auth working** for backwards compat (badges, existing scripts).
- [ ] Tokens: unhashed-at-rest vs hashed — decide. Existing keys are hashed; an
      agent needs to *see* its token once at creation, like a GitHub PAT.
- [ ] Per-token scopes (`read` / `write`) so an agent can be given read-only.
      Optional but strongly recommended — an agent with delete rights is a footgun.
- [ ] Reuse the `apiRateLimiter`; consider raising the cap for token auth.
- [ ] Write OpenAPI spec + a machine-readable discovery doc (`/.well-known/`)
      so an agent can self-document.
- [ ] Refactor shared query logic out of the socket handlers so REST and socket
      don't diverge. Without this this becomes a second, drifting implementation.

---

## Suggested order

1. **Telegram-only** — self-contained, lowest risk, validates the fork workflow.
2. **REST API + tokens** — highest value for the agentic use case, biggest surface.
3. **Multi-user** — needs a product decision (invite model) and an isolation audit.
4. **Rebrand** — mechanical, do it once the feature churn settles.
5. **Frontend rework** — only if actually needed.
