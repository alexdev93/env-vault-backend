CREATE TABLE IF NOT EXISTS vars (
  key TEXT PRIMARY KEY,
  enc_blob TEXT NOT NULL,       -- base64(iv[12 bytes] || AES-256-GCM ciphertext)
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_vars (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  var_key TEXT NOT NULL REFERENCES vars(key) ON DELETE CASCADE,
  PRIMARY KEY (project_id, var_key)
);

CREATE INDEX IF NOT EXISTS idx_project_vars_key ON project_vars(var_key);
