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
schema.sql       D1 schema (vars, projects, project_vars), idempotent
cli/envvault.sh  the CLI, served at /envvault.sh
cli/install.sh   installer, served at /install.sh
test/smoke.mjs   end-to-end checks of every route and the CLI
postman/         API collection + local / production environments
wrangler.toml    Worker name (env-vault-api), D1 binding, static assets (dist/)
```

## Commands

```bash
npm install
npm run db:init   # create tables in the local D1 database
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

## Database

```bash
npx wrangler d1 execute env-vault-db --remote --command "SELECT key, updated_at FROM vars"
```

For schema changes, edit `schema.sql`, then run
`npx wrangler d1 execute env-vault-db --remote --file=schema.sql`. It's safe
to re-run.

## Adding an API endpoint

Everything routes through `handleApi` in `src/index.js`. Add an
`if (pathname === … && method === …)` block after the auth check. Auth is
enforced there for everything except `/api/login` and `/api/logout`. Use
`readBody()` for JSON input and `env.DB.batch()` when a change spans several
statements. Add a check to `test/smoke.mjs`, and if the dashboard needs the
endpoint, a wrapper in env-vault-web's `src/api.ts`.
