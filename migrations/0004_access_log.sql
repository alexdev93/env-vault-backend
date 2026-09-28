-- Who reads what: every pull of a project's variables, every secret read,
-- every change, login and failed auth, and every API-token call. Written in the
-- background after the response; rows older than 90 days are pruned on insert.
-- Never holds a secret value.
CREATE TABLE IF NOT EXISTS access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,          -- env_pull, value_read, token_read, write, login, login_failed, auth_failed, api_read
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  auth TEXT NOT NULL,          -- bearer (CLI / API token), session (dashboard), none
  project TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT '',
  target TEXT NOT NULL DEFAULT '',   -- what was read or changed: a key, an item title, "DATABASE_URL on main"
  vars_count INTEGER,          -- how many variables an env pull returned
  client TEXT NOT NULL DEFAULT '',   -- ENV_VAULT_CLIENT, or the machine's hostname (sent by the CLI)
  host TEXT NOT NULL DEFAULT '',     -- the machine's hostname (sent by the CLI)
  ci TEXT NOT NULL DEFAULT '',       -- "github-actions owner/repo@main run 123" (sent by the CLI)
  command TEXT NOT NULL DEFAULT '',  -- run, get, list, info (sent by the CLI)
  ip TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  as_org TEXT NOT NULL DEFAULT '',   -- the network: "Hetzner Online GmbH", "Cloudflare, Inc."
  colo TEXT NOT NULL DEFAULT '',     -- Cloudflare data center that served it
  user_agent TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_access_log_at ON access_log(at);
CREATE INDEX IF NOT EXISTS idx_access_log_project ON access_log(project, at);
CREATE INDEX IF NOT EXISTS idx_access_log_kind ON access_log(kind, at);
