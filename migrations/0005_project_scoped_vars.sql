-- Variables belong to one project. Before this, a key was global (vars.key was
-- the primary key) and project_vars only tagged it, so saving GEMINI_API_KEY for
-- a second project replaced the first project's value. Now every variable has
-- its own id and project, and the same key can hold a different value in each
-- project. project_id NULL is a personal variable, used by no project.
--
-- Existing data: a variable tagged with several projects becomes one copy per
-- project (same value, notes and history); an untagged one stays personal.
-- History owners change from "var:KEY" to "var:ID".

CREATE TABLE vars_new (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  key TEXT NOT NULL,
  enc_blob TEXT NOT NULL,       -- base64(iv[12 bytes] || AES-256-GCM ciphertext)
  notes TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

-- A random v4 UUID, built in SQL.
INSERT INTO vars_new (id, project_id, key, enc_blob, notes, updated_at)
  SELECT
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' ||
      substr('89ab', 1 + abs(random()) % 4, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
    pv.project_id, v.key, v.enc_blob, v.notes, v.updated_at
  FROM vars v JOIN project_vars pv ON pv.var_key = v.key;

INSERT INTO vars_new (id, project_id, key, enc_blob, notes, updated_at)
  SELECT
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' ||
      substr('89ab', 1 + abs(random()) % 4, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
    NULL, v.key, v.enc_blob, v.notes, v.updated_at
  FROM vars v WHERE NOT EXISTS (SELECT 1 FROM project_vars pv WHERE pv.var_key = v.key);

-- Every copy gets the history of the variable it came from, oldest first.
INSERT INTO value_history (owner, enc_blob, created_at)
  SELECT 'var:' || n.id, h.enc_blob, h.created_at
  FROM value_history h JOIN vars_new n ON h.owner = 'var:' || n.key
  ORDER BY h.id;
-- Then the old key-based owners go (keys never contain '-', ids always do).
DELETE FROM value_history WHERE owner LIKE 'var:%' AND owner NOT LIKE 'var:%-%';

DROP TABLE project_vars;
DROP TABLE vars;
ALTER TABLE vars_new RENAME TO vars;

-- One key per project, and one per key among personal variables.
CREATE UNIQUE INDEX idx_vars_project_key ON vars(coalesce(project_id, ''), key);
CREATE INDEX idx_vars_key ON vars(key);
