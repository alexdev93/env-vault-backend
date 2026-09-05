# env-vault backend

A Cloudflare Worker: a JSON API backed by D1 (SQL), serving the dashboard
in `public/` as static assets from the same deployment. This is the live,
web-managed vault — see the main [README](../README.md) for how to use it
day to day. This file is implementation notes for maintaining it.

## Layout

- `src/index.js` — routing + all `/api/*` handlers
- `src/crypto.js` — AES-256-GCM encrypt/decrypt, session cookie signing, auth checks
- `schema.sql` — D1 schema (`vars`, `projects`, `project_vars`)
- `public/index.html` — the dashboard (single file, no build step)
- `public/envvault.sh` — the CLI users install to pull secrets at runtime
- `public/install.sh` — one-liner installer for `envvault.sh`

## How auth works

Two independent ways in, both checked on every `/api/*` request except
`/api/login`:

- **Session cookie** — `POST /api/login` with the `DASHBOARD_PASSWORD`
  secret sets an HttpOnly, Secure, signed cookie (`ev_session=<expiry>.<hmac>`,
  verified with `SESSION_SECRET`, no server-side session table — it's
  stateless, just a signed expiry). This is what the browser dashboard uses.
- **Bearer token** — `Authorization: Bearer <API_TOKEN>`. This is what
  `envvault` (CLI/containers/CI) uses. Same token for everything since
  this is single-user; there's no per-project token scoping.

## Secrets (set via `wrangler secret put`, never in git)

| Secret | Purpose |
| --- | --- |
| `ENCRYPTION_KEY` | 32 random bytes, base64 — AES-256-GCM key for values at rest in D1 |
| `SESSION_SECRET` | HMAC key for signing the dashboard session cookie |
| `API_TOKEN` | The bearer token `envvault` uses |
| `DASHBOARD_PASSWORD` | The web login password |

To rotate any of them: `printf '%s' "$NEWVALUE" | wrangler secret put NAME`
(run from `backend/`). Rotating `DASHBOARD_PASSWORD` or `API_TOKEN` takes
effect immediately; rotating `ENCRYPTION_KEY` does **not** re-encrypt
existing rows — do that manually (decrypt-all under the old key, re-encrypt
under the new one, in one script) before rotating, or values become
unreadable.

## Manual deploy

Normally CI does this (`.github/workflows/deploy-backend.yml` on any push
touching `backend/**`). To do it by hand:

```bash
cd backend
CLOUDFLARE_API_TOKEN=<token with Workers Scripts:Edit, D1:Edit> wrangler deploy
```

## Database

```bash
cd backend
wrangler d1 execute env-vault-db --remote --command "SELECT * FROM projects"
```

Schema changes: edit `schema.sql`, then
`wrangler d1 execute env-vault-db --remote --file=schema.sql` (writes are
idempotent — every statement is `CREATE TABLE IF NOT EXISTS` / `CREATE
INDEX IF NOT EXISTS`, safe to re-run).

## Adding an API endpoint

Everything routes through the single `handleApi` function in
`src/index.js` — no framework, just pathname/method matching. Add a new
`if (pathname === ... && method === ...)` block; auth is already enforced
above that point for everything except `/api/login`, `/api/logout`, and
`/api/whoami`.
