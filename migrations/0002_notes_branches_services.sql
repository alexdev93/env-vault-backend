-- Notes on everything, project details, services (where each dependency lives),
-- and per-branch variable overrides. Applied once by `wrangler d1 migrations
-- apply`, which records it in d1_migrations so the ALTERs never run twice.

ALTER TABLE vars ADD COLUMN notes TEXT NOT NULL DEFAULT '';

ALTER TABLE projects ADD COLUMN notes TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN repo_url TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN site_url TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';

-- Where a project's pieces live: database on Neon, hosting on Cloudflare, ...
-- Plain metadata, not encrypted: keep passwords and keys in vars.
CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT '',        -- database, hosting, auth, email, ...
  provider TEXT NOT NULL DEFAULT '',    -- neon, cloudflare, ...
  url TEXT NOT NULL DEFAULT '',         -- console / dashboard link
  account TEXT NOT NULL DEFAULT '',     -- who you sign in as
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_services_project ON services(project_id);

-- A branch inherits the project's default variables; branch_vars override
-- them (or add keys) for that branch only.
CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, name)
);

CREATE TABLE IF NOT EXISTS branch_vars (
  branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  enc_blob TEXT NOT NULL,               -- same format as vars.enc_blob
  notes TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, key)
);

UPDATE projects SET updated_at = created_at WHERE updated_at = '';
