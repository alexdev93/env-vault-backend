-- Value history, richer project/service details, service <-> variable links,
-- and general-purpose personal items (logins, secure notes, secrets).

-- The last few replaced values of every variable, branch variable and item.
-- owner is "var:KEY", "branch:BRANCH_ID:KEY" or "item:ITEM_ID".
CREATE TABLE IF NOT EXISTS value_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  enc_blob TEXT NOT NULL,               -- the replaced value, encrypted like vars.enc_blob
  created_at TEXT NOT NULL              -- when it was replaced
);
CREATE INDEX IF NOT EXISTS idx_value_history_owner ON value_history(owner, id);

ALTER TABLE projects ADD COLUMN status TEXT NOT NULL DEFAULT '';     -- idea, building, live, maintenance, archived
ALTER TABLE projects ADD COLUMN stack TEXT NOT NULL DEFAULT '';      -- "Node 22 · Express · Postgres"
ALTER TABLE projects ADD COLUMN details TEXT NOT NULL DEFAULT '[]';  -- JSON [{label, value}]

ALTER TABLE services ADD COLUMN name TEXT NOT NULL DEFAULT '';       -- the resource at the provider, e.g. the Neon project
ALTER TABLE services ADD COLUMN region TEXT NOT NULL DEFAULT '';
ALTER TABLE services ADD COLUMN plan TEXT NOT NULL DEFAULT '';

-- Which variables a service provides (DATABASE_URL comes from Neon).
CREATE TABLE IF NOT EXISTS service_vars (
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  var_key TEXT NOT NULL,
  PRIMARY KEY (service_id, var_key)
);

-- Personal vault items that aren't environment variables.
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('login', 'note', 'secret')),
  title TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  enc_blob TEXT NOT NULL,               -- password, note body or secret value
  notes TEXT NOT NULL DEFAULT '',
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
