# env-vault-backend

The core of [env-vault](https://env-vault-api.alexdev93.workers.dev): a
Cloudflare Worker API backed by D1, plus the `envvault` CLI that apps use to
pull their variables at runtime. The dashboard lives in
[env-vault-web](https://github.com/alexdev93/env-vault-web). Both are combined
and deployed from the private `env-vault` repo, where this repo is the
`backend/` submodule.

```text
src/index.js     routing + every /api/* handler; other paths go to static assets
src/crypto.js    AES-256-GCM encrypt/decrypt, session cookies, bearer-token auth
src/activity.js  access log (who pulled/read/changed what, from where) + its reports
migrations/      D1 schema as numbered migrations (wrangler d1 migrations)
cli/envvault.sh  the CLI, served at /envvault.sh
cli/install.sh   installer, served at /install.sh
test/smoke.mjs   end-to-end checks of every route and the CLI
postman/         API collection + local / production environments
wrangler.toml    Worker name (env-vault-api), D1 binding, static assets (dist/)
```

## Commands

```bash
npm install
npm run db:init   # apply migrations/ to the local D1 database
npm run dev       # http://localhost:8787, local D1 + secrets from .dev.vars
npm test          # smoke test: real wrangler dev on :8788, throwaway secrets, temp DB
```

`npm run assets` builds `dist/` from `cli/*.sh`, plus the dashboard if
`WEB_DIST` points at a web build. `npm run deploy` refuses to run without the
dashboard in `dist/`, so a deploy from this repo alone can't wipe the live
site. Deploy from the root repo instead.

Local secrets go in `.dev.vars` (git-ignored). Use throwaway values:

```bash
cat > .dev.vars <<EOV
ENCRYPTION_KEY="$(openssl rand -base64 32)"
SESSION_SECRET="$(openssl rand -hex 32)"
API_TOKEN="dev-token-$(openssl rand -hex 16)"
DASHBOARD_PASSWORD="dev-password"
EOV
```

## Using the CLI

```bash
curl -fsS https://env-vault-api.alexdev93.workers.dev/install.sh | sh
envvault login                       # saves URL + API token to ~/.config/env-vault/config (mode 600)
envvault run my-api -- npm start     # runs the command with my-api's variables injected
envvault get my-api DATABASE_URL     # print one value
envvault list my-api                 # list variable names
envvault info my-api                 # details: notes, URLs, services, branches
envvault run my-api -b main -- node server.js   # main's overrides on top of the defaults
```

**Name each server** so the dashboard's Activity page can tell them apart:
set `ENV_VAULT_CLIENT` (e.g. `ENV_VAULT_CLIENT=cheat-sheet-prod envvault run
cheat-sheet -- node server.js`), or give a name at `envvault login`. Without
one, the machine's hostname is used. The CLI also sends which command ran and,
in CI or on a hosting platform (GitHub Actions, GitLab, Vercel, Netlify,
Cloudflare Pages, Render, Fly, Railway, Kubernetes, Docker), where it runs.
Nothing secret is sent.

`-b BRANCH` (or `--branch BRANCH`) works with `run`, `get` and `list`.
Without it you get the project's default variables, as before. With it,
the branch's own variables are layered on top: they override defaults with
the same name and add keys that only that branch has. An unknown branch is an
error, so CI never silently runs with the wrong values. In GitHub Actions:

```yaml
- run: envvault run my-api -b "${{ github.ref_name }}" -- node server.js
  env:
    ENV_VAULT_TOKEN: ${{ secrets.ENV_VAULT_TOKEN }}
```

In CI or containers, set `ENV_VAULT_TOKEN` (and optionally `ENV_VAULT_URL`)
as environment variables instead of running `envvault login`. The CLI calls
`GET /api/projects/<name>/env` with the bearer token and `exec`s your command
with the values exported. Nothing is written to disk.

## Secrets (set with `wrangler secret put`, never in git)

| Secret | Purpose |
| --- | --- |
| `ENCRYPTION_KEY` | 32 random bytes, base64: the AES-256-GCM key for values at rest in D1 |
| `SESSION_SECRET` | HMAC key for signing the dashboard session cookie |
| `API_TOKEN` | The bearer token `envvault` uses |
| `DASHBOARD_PASSWORD` | The web login password |

To rotate a secret, run `printf '%s' "$NEWVALUE" | npx wrangler secret put NAME`.
- Rotating `DASHBOARD_PASSWORD` or `API_TOKEN` takes effect immediately.
- Rotating `ENCRYPTION_KEY` does **not** re-encrypt existing rows. Decrypt
  everything under the old key and re-encrypt under the new one first, or the
  stored values become unreadable.

## Data model

- **vars**: a variable's default value (encrypted) and notes, linked to
  any number of projects through **project_vars**.
- **projects**: name, description, notes, `repo_url`, `site_url`, `status`
  (idea, building, live, maintenance, archived), `stack`, and free-form
  `details` (`[{label, value}]`).
- **services**: where a project's pieces live, e.g. `{kind: "database",
  provider: "neon", name: "my-db", url: "https://console.neon.tech",
  account: "you@gmail.com", region, plan}`, plus **service_vars**: which
  variables each one provides (`var_keys`).
- **branches**: a project's branches (`main`, `feature/x`, ...) with notes.
- **branch_vars**: per-branch values (encrypted) that override or add to the
  project's defaults.
- **items**: the personal vault: logins (`url`, `username`, password),
  secure notes and secrets, optionally linked to a project.
- **access_log**: who pulled which project, read a secret, changed
  something, signed in or presented a bad token: time, project, branch,
  target, the caller's name/host/CI (from the CLI), IP, country, network
  (ASN), user agent, status. Written after the response (`ctx.waitUntil`,
  `src/activity.js`), kept 90 days, never contains a value. The dashboard's
  own browsing (listing names) isn't logged, nor are credential-less 401s.
- **value_history**: the last 5 replaced values (encrypted) of every
  variable, branch value and item. Saving an unchanged value adds nothing;
  renames carry the history along; deleting something deletes its history.

Only values are encrypted (variables, branch values, item passwords/notes/
secrets, and their history). Titles, notes, URLs, usernames and service
details are stored as plain text, so keep passwords and keys in values, not
in notes.

## Database

```bash
npx wrangler d1 execute env-vault-db --remote --command "SELECT key, updated_at FROM vars"
```

The schema is `migrations/NNNN_*.sql`, applied in order by
`wrangler d1 migrations apply`, which records what it applied in
`d1_migrations`, so each file runs exactly once. `0001_initial.sql` is the
original schema (all `IF NOT EXISTS`, so it's a no-op on a database created
from the old `schema.sql`).

For a schema change, add the next numbered file, then apply it to production
**before** deploying code that uses it:

```bash
npm run db:migrate:remote   # wrangler d1 migrations apply env-vault-db --remote
```

## API

All routes except login/logout need the session cookie or the bearer token.
Projects can be addressed by id or name wherever `:project` appears. `PATCH`
routes change only the fields you send.

| Route | What it does |
| --- | --- |
| `GET /api/vars` | names + notes + projects, no values |
| `POST /api/vars` | upsert `{key, value, projects, notes?}` (notes kept if omitted) |
| `GET /api/vars/:key` | one variable's metadata |
| `PATCH /api/vars/:key` | `{key?, value?, notes?, projects?}`; a new `key` renames it, and branch overrides follow |
| `GET /api/vars/:key/value` | the decrypted value |
| `DELETE /api/vars/:key` | delete it |
| `GET /api/projects` | every project with keys, services, branches |
| `POST /api/projects` | `{name, description?, notes?, repo_url?, site_url?, status?, stack?, details?, services?: [...], branches?: ["main", {name, notes}]}` |
| `GET /api/projects/:project` | full details, including each branch's variables |
| `PATCH /api/projects/:project` | `{name?, description?, notes?, repo_url?, site_url?, status?, stack?, details?}` |
| `DELETE /api/projects/:project` | deletes it with its services and branches (variables stay) |
| `GET /api/projects/:name/env[?branch=B]` | what `envvault` calls: the decrypted map |
| `POST /api/projects/:project/services` | `{kind?, provider?, name?, url?, account?, region?, plan?, notes?, var_keys?}` (kind or provider required) |
| `PATCH` / `DELETE /api/services/:id` | edit (same fields; `var_keys` replaces the links) / delete a service |
| `POST /api/projects/:project/branches` | `{name, notes?}` |
| `GET` / `PATCH` / `DELETE /api/branches/:id` | branch details (variable names, `overrides` flag) / `{name?, notes?}` / delete |
| `POST /api/branches/:id/vars` | upsert `{key, value, notes?}` (value optional when the key exists) |
| `PATCH` / `DELETE /api/branches/:id/vars/:key` | `{key?, value?, notes?}` / delete |
| `GET /api/branches/:id/vars/:key/value` | the decrypted branch value |
| `GET /api/items` | personal items, metadata only |
| `POST /api/items` | `{type: login\|note\|secret, title, value, url?, username?, notes?, project_id?}` |
| `PATCH` / `DELETE /api/items/:id` | `{title?, url?, username?, notes?, project_id?, value?}` / delete |
| `GET /api/items/:id/value` | the decrypted password, note or secret |
| `GET /api/history?owner=O` | `[{id, created_at}]`, newest first; `O` is `var:KEY`, `branch:ID:KEY` or `item:ID` |
| `GET /api/history/:id/value` | one earlier value, decrypted |
| `POST /api/history/:id/restore` | put it back; the value it replaces goes into history |
| `GET /api/activity/summary?days=30&project=` | totals, pulls per day, heartbeat per project (last pull, by whom, sparkline data), clients and what they pull |
| `GET /api/activity?project=&kind=&client=&before=&limit=` | the access log, newest first; `kind` is a comma list (`env_pull`, `value_read`, `token_read`, `write`, `login`, `login_failed`, `auth_failed`, `api_read`); page with `before=<next>` |

## Adding an API endpoint

Everything routes through `handleApi` in `src/index.js`. Add an
`if (pathname === … && method === …)` block after the auth check. Auth is
enforced there for everything except `/api/login` and `/api/logout`. Use
`readBody()` for JSON input and `env.DB.batch()` when a change spans several
statements. Add a check to `test/smoke.mjs`, and if the dashboard needs the
endpoint, a wrapper in env-vault-web's `src/api.ts`.
