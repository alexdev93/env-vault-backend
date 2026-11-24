import {
  encryptValue,
  decryptValue,
  safeEqual,
  createSessionCookie,
  clearSessionCookie,
  isAuthed,
} from "./crypto.js";
import { activityEvents, activitySummary, recordAccess } from "./activity.js";

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
// Git branch names: main, release/1.2, feature/login-page, ...
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

// Max lengths for free-text metadata. Notes are plain text, not encrypted.
const NOTES_MAX = 10000;
const TEXT_MAX = 2000;

// How many replaced values each variable, branch variable and item keeps.
const HISTORY_KEEP = 5;
const PROJECT_STATUSES = ["", "idea", "building", "live", "maintenance", "archived"];
const ITEM_TYPES = ["login", "note", "secret"];
const DETAILS_MAX = 40;

class HttpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function err(message, status = 400) {
  return json({ error: message }, status);
}

// Always an object, even for a missing, malformed, or non-object JSON body.
async function readBody(request) {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? body : {};
}

async function requireAuth(request, env) {
  if (!(await isAuthed(request, env))) return err("unauthorized", 401);
  return null;
}

const now = () => new Date().toISOString();

// The text fields present in body, validated. Absent fields are left out, so
// the result doubles as a partial update ("only change what was sent").
function pickText(body, limits) {
  const out = {};
  for (const [field, max] of Object.entries(limits)) {
    if (body[field] === undefined) continue;
    const v = body[field] === null ? "" : body[field];
    if (typeof v !== "string" && typeof v !== "number") throw new HttpError(`${field} must be a string`);
    const s = String(v).trim();
    if (s.length > max) throw new HttpError(`${field} is longer than ${max} characters`);
    out[field] = s;
  }
  return out;
}

const PROJECT_TEXT = { description: TEXT_MAX, notes: NOTES_MAX, repo_url: TEXT_MAX, site_url: TEXT_MAX, stack: 500 };
const SERVICE_TEXT = {
  kind: 100, provider: 200, name: 200, url: TEXT_MAX, account: TEXT_MAX, region: 100, plan: 100, notes: NOTES_MAX,
};
const ITEM_TEXT = { title: 200, url: TEXT_MAX, username: TEXT_MAX, notes: NOTES_MAX };

function parseProjectName(value) {
  const name = String(value ?? "").trim().toLowerCase();
  if (!NAME_RE.test(name)) throw new HttpError("project name must be lowercase letters, numbers, hyphens");
  return name;
}

function parseKey(value) {
  const key = String(value ?? "").trim();
  if (!KEY_RE.test(key)) throw new HttpError("key must look like AN_ENV_VAR_NAME");
  return key;
}

function parseBranchName(value) {
  const name = String(value ?? "").trim();
  if (!BRANCH_RE.test(name) || name.includes("..")) {
    throw new HttpError("branch name must be letters, numbers, . _ / - (like main or feature/login)");
  }
  return name;
}

function parseService(body) {
  const fields = pickText(body, SERVICE_TEXT);
  if (!fields.kind && !fields.provider) throw new HttpError("a service needs a kind or a provider");
  return fields;
}

// The variable keys a service provides, or null when not sent.
function parseVarKeys(value) {
  if (value === undefined) return null;
  if (!Array.isArray(value)) throw new HttpError("var_keys must be a list of keys");
  return [...new Set(value.map(parseKey))];
}

// Project status, stack and free-form details ([{label, value}]), from whichever were sent.
function pickProjectExtras(body) {
  const out = {};
  if (body.status !== undefined) {
    const status = String(body.status ?? "").trim().toLowerCase();
    if (!PROJECT_STATUSES.includes(status)) throw new HttpError(`status must be one of: ${PROJECT_STATUSES.filter(Boolean).join(", ")}`);
    out.status = status;
  }
  if (body.details !== undefined) {
    if (!Array.isArray(body.details)) throw new HttpError("details must be a list of {label, value}");
    const details = body.details
      .map((d) => pickText(d && typeof d === "object" ? d : {}, { label: 200, value: TEXT_MAX }))
      .filter((d) => d.label || d.value)
      .map((d) => ({ label: d.label ?? "", value: d.value ?? "" }));
    if (details.length > DETAILS_MAX) throw new HttpError(`at most ${DETAILS_MAX} details`);
    out.details = JSON.stringify(details);
  }
  return out;
}

function parseDetails(text) {
  try {
    const d = JSON.parse(text || "[]");
    return Array.isArray(d) ? d : [];
  } catch {
    return [];
  }
}

// ---- value history ----
// Whenever a value is replaced, the old one goes into value_history under its
// owner ("var:VAR_ID", "branch:BRANCH_ID:KEY", "item:ITEM_ID"), and only the
// newest HISTORY_KEEP entries per owner are kept.

const varOwner = (id) => `var:${id}`;
const branchOwner = (branchId, key) => `branch:${branchId}:${key}`;
const itemOwner = (id) => `item:${id}`;

// Where each kind of owner keeps its current value.
const OWNER_SQL = {
  var: {
    select: "SELECT enc_blob FROM vars WHERE id = ?1",
    update: "UPDATE vars SET enc_blob = ?1, updated_at = ?2 WHERE id = ?3",
  },
  branch: {
    select: "SELECT enc_blob FROM branch_vars WHERE branch_id = ?1 AND key = ?2",
    update: "UPDATE branch_vars SET enc_blob = ?1, updated_at = ?2 WHERE branch_id = ?3 AND key = ?4",
  },
  item: {
    select: "SELECT enc_blob FROM items WHERE id = ?1",
    update: "UPDATE items SET enc_blob = ?1, updated_at = ?2 WHERE id = ?3",
  },
};

function parseOwner(owner) {
  const s = String(owner ?? "");
  let m;
  if ((m = s.match(/^var:([0-9a-f-]{36})$/))) return { kind: "var", params: [m[1]] };
  if ((m = s.match(/^branch:([0-9a-f-]{36}):([A-Za-z_][A-Za-z0-9_]*)$/))) return { kind: "branch", params: [m[1], m[2]] };
  if ((m = s.match(/^item:([0-9a-f-]{36})$/))) return { kind: "item", params: [m[1]] };
  throw new HttpError("owner must look like var:ID, branch:ID:KEY or item:ID");
}

// Statements that save oldBlob into owner's history, unless the value is unchanged.
async function historyStmts(env, owner, oldBlob, newPlain) {
  if (oldBlob == null) return [];
  let same = false;
  try {
    same = (await decryptValue(env, oldBlob)) === newPlain;
  } catch {
    // unreadable old value: keep it anyway
  }
  if (same) return [];
  return [
    env.DB.prepare("INSERT INTO value_history (owner, enc_blob, created_at) VALUES (?1, ?2, ?3)").bind(owner, oldBlob, now()),
    env.DB.prepare(
      "DELETE FROM value_history WHERE owner = ?1 AND id NOT IN " +
        "(SELECT id FROM value_history WHERE owner = ?1 ORDER BY id DESC LIMIT ?2)"
    ).bind(owner, HISTORY_KEEP),
  ];
}

// Statements that set owner's value to plain, recording the current one in history.
async function setValueStmts(env, owner, plain) {
  const { kind, params } = parseOwner(owner);
  const row = await env.DB.prepare(OWNER_SQL[kind].select).bind(...params).first();
  if (!row) throw new HttpError("it no longer exists", 404);
  return [
    ...(await historyStmts(env, owner, row.enc_blob, plain)),
    env.DB.prepare(OWNER_SQL[kind].update).bind(await encryptValue(env, plain), now(), ...params),
  ];
}

// "SET a = ?1, b = ?2" plus its values, for a partial UPDATE.
function setClause(fields) {
  const cols = Object.keys(fields);
  return { sql: cols.map((c, i) => `${c} = ?${i + 1}`).join(", "), values: cols.map((c) => fields[c]), next: cols.length + 1 };
}

// Insert statements for a new service and its variable links.
function insertServiceStmts(env, id, projectId, s, varKeys, ts) {
  return [
    env.DB.prepare(
      "INSERT INTO services (id, project_id, kind, provider, name, url, account, region, plan, notes, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)"
    ).bind(id, projectId, s.kind ?? "", s.provider ?? "", s.name ?? "", s.url ?? "", s.account ?? "", s.region ?? "", s.plan ?? "", s.notes ?? "", ts),
    ...(varKeys || []).map((k) => env.DB.prepare("INSERT INTO service_vars (service_id, var_key) VALUES (?1, ?2)").bind(id, k)),
  ];
}

// undefined when not sent, null to unlink, or a known project id.
async function parseItemProject(env, value) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const project = await env.DB.prepare("SELECT id FROM projects WHERE id = ?1").bind(String(value)).first();
  if (!project) throw new HttpError("unknown project id");
  return project.id;
}

function isUniqueError(e) {
  return /UNIQUE/i.test(e.message);
}

// Projects are addressed by id or name, so `curl .../api/projects/my-api` works.
async function findProject(env, ref) {
  const project = await env.DB.prepare("SELECT * FROM projects WHERE id = ?1 OR name = lower(?1)").bind(ref).first();
  if (!project) throw new HttpError("no such project", 404);
  return project;
}

async function findBranch(env, id) {
  const branch = await env.DB.prepare("SELECT * FROM branches WHERE id = ?1").bind(id).first();
  if (!branch) throw new HttpError("no such branch", 404);
  return branch;
}

// Names and metadata only: values are fetched one at a time, per reveal or copy
// (GET /api/vars/:id/value), so the dashboard never holds every secret at once.
// Each variable belongs to one project (project null = personal), so the same
// key can appear once per project, each with its own value.
const VAR_COLUMNS =
  "SELECT v.id, v.key, 'var' AS type, v.notes, v.updated_at, v.project_id, p.name AS project " +
  "FROM vars v LEFT JOIN projects p ON p.id = v.project_id";

async function listVars(env) {
  return (await env.DB.prepare(`${VAR_COLUMNS} ORDER BY v.key, p.name`).all()).results;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A variable by id, or by key. A key alone must be unambiguous; otherwise
// ?project=NAME picks the project (?project= with no name: the personal one).
async function findVar(env, ref, url) {
  if (UUID_RE.test(ref)) {
    const v = await env.DB.prepare(`${VAR_COLUMNS} WHERE v.id = ?1`).bind(ref).first();
    if (!v) throw new HttpError("no such variable", 404);
    return v;
  }
  const projectRef = url.searchParams.get("project");
  let rows;
  if (projectRef === null) {
    rows = (await env.DB.prepare(`${VAR_COLUMNS} WHERE v.key = ?1 ORDER BY p.name`).bind(ref).all()).results;
  } else if (projectRef === "") {
    rows = (await env.DB.prepare(`${VAR_COLUMNS} WHERE v.key = ?1 AND v.project_id IS NULL`).bind(ref).all()).results;
  } else {
    const project = await findProject(env, projectRef);
    rows = (await env.DB.prepare(`${VAR_COLUMNS} WHERE v.key = ?1 AND v.project_id = ?2`).bind(ref, project.id).all()).results;
  }
  if (rows.length === 0) throw new HttpError("no such variable", 404);
  if (rows.length > 1) {
    const where = rows.map((r) => r.project ?? "personal").join(", ");
    throw new HttpError(`${ref} is in ${rows.length} places (${where}): add ?project=NAME or use its id`, 409);
  }
  return rows[0];
}

// The project a variable goes in: a known project id or name, or null for personal.
async function parseVarProject(env, value) {
  if (value === null || value === undefined || value === "") return null;
  return (await findProject(env, String(value))).id;
}

// The project ids a new variable is saved in. project_id names one; the older
// projects: [ids] form still works, and saves an independent copy in each.
async function parseVarProjects(env, body) {
  if (body.project_id !== undefined) return [await parseVarProject(env, body.project_id)];
  if (body.projects === undefined) return [null];
  if (!Array.isArray(body.projects)) throw new HttpError("projects must be a list of project ids");
  const ids = [...new Set(body.projects.map(String))];
  if (ids.length === 0) return [null];
  const known = new Set((await env.DB.prepare("SELECT id FROM projects").all()).results.map((p) => p.id));
  if (ids.some((id) => !known.has(id))) throw new HttpError("unknown project id");
  return ids;
}

const varLabel = (key, projectName) => (projectName ? `${key} in ${projectName}` : `personal ${key}`);

async function listProjects(env) {
  const [projects, links, services, branches, serviceVars] = await Promise.all([
    env.DB.prepare("SELECT * FROM projects ORDER BY name").all(),
    env.DB.prepare("SELECT project_id, key FROM vars WHERE project_id IS NOT NULL").all(),
    env.DB.prepare("SELECT * FROM services ORDER BY kind, provider").all(),
    env.DB.prepare("SELECT id, project_id, name, notes, updated_at FROM branches ORDER BY name").all(),
    env.DB.prepare("SELECT service_id, var_key FROM service_vars ORDER BY var_key").all(),
  ]);
  const keysByService = {};
  for (const l of serviceVars.results) (keysByService[l.service_id] ||= []).push(l.var_key);
  for (const svc of services.results) svc.var_keys = keysByService[svc.id] || [];
  const group = (rows, field) => {
    const out = {};
    for (const r of rows) (out[r[field]] ||= []).push(r);
    return out;
  };
  const keysByProject = {};
  for (const l of links.results) (keysByProject[l.project_id] ||= []).push(l.key);
  const servicesByProject = group(services.results, "project_id");
  const branchesByProject = group(branches.results, "project_id");
  return projects.results.map((p) => ({
    ...p,
    details: parseDetails(p.details),
    keys: (keysByProject[p.id] || []).sort(),
    services: servicesByProject[p.id] || [],
    branches: branchesByProject[p.id] || [],
  }));
}

// A branch's own variables (names and metadata), each marked with whether it
// overrides a project default or only exists on the branch.
async function branchDetail(env, branch) {
  const [vars, defaults] = await Promise.all([
    env.DB.prepare("SELECT key, notes, updated_at FROM branch_vars WHERE branch_id = ?1 ORDER BY key").bind(branch.id).all(),
    env.DB.prepare("SELECT key FROM vars WHERE project_id = ?1").bind(branch.project_id).all(),
  ]);
  const defaultKeys = new Set(defaults.results.map((r) => r.key));
  return { ...branch, vars: vars.results.map((v) => ({ ...v, overrides: defaultKeys.has(v.key) })) };
}

async function projectEnv(env, project, branchName) {
  const rows = await env.DB.prepare(
    "SELECT key, enc_blob FROM vars WHERE project_id = ?1"
  ).bind(project.id).all();
  const out = {};
  for (const r of rows.results) out[r.key] = await decryptValue(env, r.enc_blob);
  if (branchName === null) return out;
  const branch = await env.DB.prepare("SELECT id FROM branches WHERE project_id = ?1 AND name = ?2")
    .bind(project.id, branchName)
    .first();
  if (!branch) throw new HttpError(`project ${project.name} has no branch ${branchName}`, 404);
  const overrides = await env.DB.prepare("SELECT key, enc_blob FROM branch_vars WHERE branch_id = ?1").bind(branch.id).all();
  for (const r of overrides.results) out[r.key] = await decryptValue(env, r.enc_blob);
  return out;
}

async function handleApi(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/api/login" && method === "POST") {
    const body = await readBody(request);
    if (!safeEqual(String(body.password ?? ""), env.DASHBOARD_PASSWORD)) return err("wrong password", 401);
    return json({ ok: true }, 200, { "Set-Cookie": await createSessionCookie(env) });
  }

  if (pathname === "/api/logout" && method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
  }

  if (pathname === "/api/whoami" && method === "GET") {
    const authErr = await requireAuth(request, env);
    if (authErr) return authErr;
    return json({ ok: true });
  }

  // everything below requires auth
  const authErr = await requireAuth(request, env);
  if (authErr) return authErr;

  if (pathname === "/api/token" && method === "GET") {
    return json({ token: env.API_TOKEN, url: url.origin });
  }

  // ---- variables (project defaults) ----
  // Each variable belongs to one project, or to none (personal). The same key can
  // exist in several projects, each with its own value; saving one never touches another.

  if (pathname === "/api/vars" && method === "GET") {
    return json(await listVars(env));
  }

  // Create, or replace the value of, KEY in a project: {key, value, notes?, project_id?}.
  // project_id may be an id or a name; leave it out for a personal variable.
  if (pathname === "/api/vars" && method === "POST") {
    const body = await readBody(request);
    const key = parseKey(body.key);
    const value = String(body.value ?? "");
    const { notes } = pickText(body, { notes: NOTES_MAX });
    const projectIds = await parseVarProjects(env, body);
    const ts = now();
    const ids = [];
    // One atomic batch: every value and its history change together or not at all.
    // Notes are only touched when sent, so older clients don't wipe them.
    const stmts = [];
    for (const projectId of projectIds) {
      const old = await env.DB.prepare("SELECT id, enc_blob FROM vars WHERE key = ?1 AND coalesce(project_id, '') = coalesce(?2, '')")
        .bind(key, projectId).first();
      const encBlob = await encryptValue(env, value);
      if (old) {
        stmts.push(
          ...(await historyStmts(env, varOwner(old.id), old.enc_blob, value)),
          env.DB.prepare("UPDATE vars SET enc_blob = ?1, updated_at = ?2, notes = coalesce(?3, notes) WHERE id = ?4")
            .bind(encBlob, ts, notes ?? null, old.id)
        );
        ids.push(old.id);
      } else {
        const id = crypto.randomUUID();
        stmts.push(
          env.DB.prepare("INSERT INTO vars (id, project_id, key, enc_blob, notes, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
            .bind(id, projectId, key, encBlob, notes ?? "", ts)
        );
        ids.push(id);
      }
    }
    await env.DB.batch(stmts);
    return json({ ok: true, id: ids[0], ids, key });
  }

  // :ref is a variable id, or its key (add ?project=NAME when several projects have that key).
  const valueMatch = pathname.match(/^\/api\/vars\/([^/]+)\/value$/);
  if (valueMatch && method === "GET") {
    const v = await findVar(env, decodeURIComponent(valueMatch[1]), url);
    const row = await env.DB.prepare("SELECT enc_blob FROM vars WHERE id = ?1").bind(v.id).first();
    return json({ value: await decryptValue(env, row.enc_blob) }, 200, { "Cache-Control": "no-store" });
  }

  const varMatch = pathname.match(/^\/api\/vars\/([^/]+)$/);
  if (varMatch && method === "GET") {
    return json(await findVar(env, decodeURIComponent(varMatch[1]), url));
  }

  // Partial edit: any of key (rename), value, notes, project_id (move to another project, or null for personal).
  if (varMatch && method === "PATCH") {
    const v = await findVar(env, decodeURIComponent(varMatch[1]), url);
    const body = await readBody(request);
    const newKey = body.key === undefined ? v.key : parseKey(body.key);
    let projectId = v.project_id;
    if (body.project_id !== undefined) {
      projectId = await parseVarProject(env, body.project_id);
    } else if (body.projects !== undefined) {
      // Older clients send projects: [ids]; a variable now lives in one project.
      if (!Array.isArray(body.projects)) return err("projects must be a list of project ids");
      const ids = [...new Set(body.projects.map(String))];
      if (ids.length > 1) return err("a variable belongs to one project: save a separate copy in each project");
      projectId = await parseVarProject(env, ids[0] ?? null);
    }
    const fields = pickText(body, { notes: NOTES_MAX });
    const stmts = [];
    if (body.value !== undefined) {
      const value = String(body.value ?? "");
      const row = await env.DB.prepare("SELECT enc_blob FROM vars WHERE id = ?1").bind(v.id).first();
      stmts.push(...(await historyStmts(env, varOwner(v.id), row.enc_blob, value)));
      fields.enc_blob = await encryptValue(env, value);
    }

    if (newKey !== v.key || projectId !== v.project_id) {
      const clash = await env.DB.prepare(
        "SELECT p.name FROM vars v LEFT JOIN projects p ON p.id = v.project_id " +
          "WHERE v.key = ?1 AND coalesce(v.project_id, '') = coalesce(?2, '') AND v.id != ?3"
      ).bind(newKey, projectId, v.id).first();
      if (clash) return err(`${varLabel(newKey, clash.name)} already exists`, 409);
      fields.key = newKey;
      fields.project_id = projectId;
    }

    // Renamed within its project: that project's branch overrides and service links follow.
    if (newKey !== v.key && v.project_id && projectId === v.project_id) {
      const branchClash = await env.DB.prepare(
        "SELECT 1 FROM branch_vars bv JOIN branches b ON b.id = bv.branch_id WHERE b.project_id = ?1 AND bv.key = ?2"
      ).bind(v.project_id, newKey).first();
      if (branchClash) return err(`a branch already overrides ${newKey}`, 409);
      stmts.push(
        // Branch history owners are "branch:<36-char id>:KEY".
        env.DB.prepare(
          "UPDATE value_history SET owner = 'branch:' || substr(owner, 8, 36) || ':' || ?3 WHERE owner IN " +
            "(SELECT 'branch:' || b.id || ':' || ?2 FROM branches b WHERE b.project_id = ?1)"
        ).bind(v.project_id, v.key, newKey),
        env.DB.prepare(
          "UPDATE branch_vars SET key = ?3 WHERE key = ?2 AND branch_id IN (SELECT id FROM branches WHERE project_id = ?1)"
        ).bind(v.project_id, v.key, newKey),
        env.DB.prepare(
          "UPDATE service_vars SET var_key = ?3 WHERE var_key = ?2 AND service_id IN (SELECT id FROM services WHERE project_id = ?1)"
        ).bind(v.project_id, v.key, newKey)
      );
    }

    fields.updated_at = now();
    const set = setClause(fields);
    stmts.push(env.DB.prepare(`UPDATE vars SET ${set.sql} WHERE id = ?${set.next}`).bind(...set.values, v.id));
    try {
      await env.DB.batch(stmts);
    } catch (e) {
      if (isUniqueError(e)) return err(`${newKey} already exists there`, 409);
      throw e;
    }
    return json({ ok: true, id: v.id, key: newKey, project_id: projectId });
  }

  if (varMatch && method === "DELETE") {
    let v;
    try {
      v = await findVar(env, decodeURIComponent(varMatch[1]), url);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return json({ ok: true });
      throw e;
    }
    await env.DB.batch([
      env.DB.prepare("DELETE FROM value_history WHERE owner = ?1").bind(varOwner(v.id)),
      env.DB.prepare("DELETE FROM vars WHERE id = ?1").bind(v.id),
    ]);
    return json({ ok: true });
  }

  // ---- projects ----

  if (pathname === "/api/projects" && method === "GET") {
    return json(await listProjects(env));
  }

  // Accepts the details up front too: notes, repo_url, site_url, status, stack, details, and lists of
  // services ({kind, provider, name, url, account, region, plan, notes}) and branches ({name, notes} or "name").
  if (pathname === "/api/projects" && method === "POST") {
    const body = await readBody(request);
    const name = parseProjectName(body.name);
    const fields = { ...pickText(body, PROJECT_TEXT), ...pickProjectExtras(body) };
    const services = (Array.isArray(body.services) ? body.services : []).map((s) => parseService(s || {}));
    const branchInput = Array.isArray(body.branches) ? body.branches : [];
    const branches = branchInput.map((b) =>
      typeof b === "string" ? { name: parseBranchName(b), notes: "" } : { name: parseBranchName(b?.name), ...pickText(b, { notes: NOTES_MAX }) }
    );
    if (new Set(branches.map((b) => b.name)).size !== branches.length) return err("duplicate branch name");

    const id = crypto.randomUUID();
    const ts = now();
    try {
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO projects (id, name, description, notes, repo_url, site_url, status, stack, details, created_at, updated_at) " +
            "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)"
        ).bind(
          id, name, fields.description ?? "", fields.notes ?? "", fields.repo_url ?? "", fields.site_url ?? "",
          fields.status ?? "", fields.stack ?? "", fields.details ?? "[]", ts
        ),
        ...services.flatMap((s) => insertServiceStmts(env, crypto.randomUUID(), id, s, [], ts)),
        ...branches.map((b) =>
          env.DB.prepare(
            "INSERT INTO branches (id, project_id, name, notes, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)"
          ).bind(crypto.randomUUID(), id, b.name, b.notes ?? "", ts)
        ),
      ]);
    } catch (e) {
      if (isUniqueError(e)) return err("a project with that name already exists", 409);
      throw e;
    }
    return json({ ok: true, id, name });
  }

  const projEnvMatch = pathname.match(/^\/api\/projects\/([^/]+)\/env$/);
  if (projEnvMatch && method === "GET") {
    const name = decodeURIComponent(projEnvMatch[1]).toLowerCase();
    const project = await env.DB.prepare("SELECT id, name FROM projects WHERE name = ?1").bind(name).first();
    if (!project) return err("no such project", 404);
    // No ?branch (or an empty one) is the project's defaults, exactly as before branches existed.
    const branch = url.searchParams.get("branch");
    return json(await projectEnv(env, project, branch ? branch : null));
  }

  const projServicesMatch = pathname.match(/^\/api\/projects\/([^/]+)\/services$/);
  if (projServicesMatch && method === "POST") {
    const project = await findProject(env, decodeURIComponent(projServicesMatch[1]));
    const body = await readBody(request);
    const s = parseService(body);
    const varKeys = parseVarKeys(body.var_keys);
    const id = crypto.randomUUID();
    await env.DB.batch(insertServiceStmts(env, id, project.id, s, varKeys, now()));
    return json({ ok: true, id });
  }

  const projBranchesMatch = pathname.match(/^\/api\/projects\/([^/]+)\/branches$/);
  if (projBranchesMatch && method === "POST") {
    const project = await findProject(env, decodeURIComponent(projBranchesMatch[1]));
    const body = await readBody(request);
    const name = parseBranchName(body.name);
    const { notes } = pickText(body, { notes: NOTES_MAX });
    const id = crypto.randomUUID();
    const ts = now();
    try {
      await env.DB.prepare(
        "INSERT INTO branches (id, project_id, name, notes, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)"
      ).bind(id, project.id, name, notes ?? "", ts).run();
    } catch (e) {
      if (isUniqueError(e)) return err(`${project.name} already has a branch ${name}`, 409);
      throw e;
    }
    return json({ ok: true, id, name });
  }

  const projMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projMatch && method === "GET") {
    const project = await findProject(env, decodeURIComponent(projMatch[1]));
    const full = (await listProjects(env)).find((p) => p.id === project.id);
    full.branches = await Promise.all(full.branches.map((b) => branchDetail(env, b)));
    return json(full);
  }

  // Partial edit: any of name, description, notes, repo_url, site_url, status, stack, details.
  // Renaming changes what `envvault run <name>` must be called with.
  if (projMatch && method === "PATCH") {
    const project = await findProject(env, decodeURIComponent(projMatch[1]));
    const body = await readBody(request);
    const fields = { ...pickText(body, PROJECT_TEXT), ...pickProjectExtras(body) };
    if (body.name !== undefined) fields.name = parseProjectName(body.name);
    fields.updated_at = now();
    const set = setClause(fields);
    try {
      await env.DB.prepare(`UPDATE projects SET ${set.sql} WHERE id = ?${set.next}`).bind(...set.values, project.id).run();
    } catch (e) {
      if (isUniqueError(e)) return err("a project with that name already exists", 409);
      throw e;
    }
    return json({ ok: true, id: project.id, name: fields.name ?? project.name });
  }

  if (projMatch && method === "DELETE") {
    const ref = decodeURIComponent(projMatch[1]);
    const project = await env.DB.prepare("SELECT id FROM projects WHERE id = ?1 OR name = lower(?1)").bind(ref).first();
    if (!project) return json({ ok: true });
    const id = project.id;
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM value_history WHERE owner LIKE 'branch:%' AND substr(owner, 8, 36) IN (SELECT id FROM branches WHERE project_id = ?1)"
      ).bind(id),
      env.DB.prepare("DELETE FROM branch_vars WHERE branch_id IN (SELECT id FROM branches WHERE project_id = ?1)").bind(id),
      env.DB.prepare("DELETE FROM branches WHERE project_id = ?1").bind(id),
      env.DB.prepare("DELETE FROM service_vars WHERE service_id IN (SELECT id FROM services WHERE project_id = ?1)").bind(id),
      env.DB.prepare("DELETE FROM services WHERE project_id = ?1").bind(id),
      // Personal items linked to it stay, just unlinked.
      env.DB.prepare("UPDATE items SET project_id = NULL WHERE project_id = ?1").bind(id),
      // Its variables are its own, so they go with it, history included.
      env.DB.prepare("DELETE FROM value_history WHERE owner IN (SELECT 'var:' || id FROM vars WHERE project_id = ?1)").bind(id),
      env.DB.prepare("DELETE FROM vars WHERE project_id = ?1").bind(id),
      env.DB.prepare("DELETE FROM projects WHERE id = ?1").bind(id),
    ]);
    return json({ ok: true });
  }

  // ---- services ----

  const serviceMatch = pathname.match(/^\/api\/services\/([^/]+)$/);
  if (serviceMatch && method === "PATCH") {
    const id = decodeURIComponent(serviceMatch[1]);
    const row = await env.DB.prepare("SELECT * FROM services WHERE id = ?1").bind(id).first();
    if (!row) return err("no such service", 404);
    const body = await readBody(request);
    const fields = pickText(body, SERVICE_TEXT);
    if (!(fields.kind ?? row.kind) && !(fields.provider ?? row.provider)) return err("a service needs a kind or a provider");
    const varKeys = parseVarKeys(body.var_keys);
    fields.updated_at = now();
    const set = setClause(fields);
    await env.DB.batch([
      env.DB.prepare(`UPDATE services SET ${set.sql} WHERE id = ?${set.next}`).bind(...set.values, id),
      ...(varKeys
        ? [
            env.DB.prepare("DELETE FROM service_vars WHERE service_id = ?1").bind(id),
            ...varKeys.map((k) => env.DB.prepare("INSERT INTO service_vars (service_id, var_key) VALUES (?1, ?2)").bind(id, k)),
          ]
        : []),
    ]);
    return json({ ok: true, id });
  }

  if (serviceMatch && method === "DELETE") {
    const id = decodeURIComponent(serviceMatch[1]);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM service_vars WHERE service_id = ?1").bind(id),
      env.DB.prepare("DELETE FROM services WHERE id = ?1").bind(id),
    ]);
    return json({ ok: true });
  }

  // ---- branches (per-branch overrides of a project's variables) ----

  const branchValueMatch = pathname.match(/^\/api\/branches\/([^/]+)\/vars\/([^/]+)\/value$/);
  if (branchValueMatch && method === "GET") {
    const row = await env.DB.prepare("SELECT enc_blob FROM branch_vars WHERE branch_id = ?1 AND key = ?2")
      .bind(decodeURIComponent(branchValueMatch[1]), decodeURIComponent(branchValueMatch[2]))
      .first();
    if (!row) return err("no such branch variable", 404);
    return json({ value: await decryptValue(env, row.enc_blob) }, 200, { "Cache-Control": "no-store" });
  }

  const branchVarsMatch = pathname.match(/^\/api\/branches\/([^/]+)\/vars$/);
  // Upsert one branch variable. value is required when the key is new; when it
  // already exists, only the fields sent (value, notes) change.
  if (branchVarsMatch && method === "POST") {
    const branch = await findBranch(env, decodeURIComponent(branchVarsMatch[1]));
    const body = await readBody(request);
    const key = parseKey(body.key);
    const { notes } = pickText(body, { notes: NOTES_MAX });
    const exists = await env.DB.prepare("SELECT enc_blob FROM branch_vars WHERE branch_id = ?1 AND key = ?2").bind(branch.id, key).first();
    if (!exists && body.value === undefined) return err("value is required for a new branch variable");
    const value = body.value === undefined ? null : String(body.value ?? "");
    const encBlob = value === null ? null : await encryptValue(env, value);
    // An upsert would trip enc_blob's NOT NULL before resolving the conflict, so update and insert are separate.
    const sql = exists
      ? "UPDATE branch_vars SET enc_blob = coalesce(?3, enc_blob), notes = coalesce(?4, notes), updated_at = ?5 WHERE branch_id = ?1 AND key = ?2"
      : "INSERT INTO branch_vars (branch_id, key, enc_blob, notes, updated_at) VALUES (?1, ?2, ?3, coalesce(?4, ''), ?5)";
    await env.DB.batch([
      ...(exists && value !== null ? await historyStmts(env, branchOwner(branch.id, key), exists.enc_blob, value) : []),
      env.DB.prepare(sql).bind(branch.id, key, encBlob, notes ?? null, now()),
    ]);
    return json({ ok: true, key });
  }

  const branchVarMatch = pathname.match(/^\/api\/branches\/([^/]+)\/vars\/([^/]+)$/);
  // Partial edit: any of key (rename), value, notes.
  if (branchVarMatch && method === "PATCH") {
    const branchId = decodeURIComponent(branchVarMatch[1]);
    const oldKey = decodeURIComponent(branchVarMatch[2]);
    const row = await env.DB.prepare("SELECT enc_blob FROM branch_vars WHERE branch_id = ?1 AND key = ?2").bind(branchId, oldKey).first();
    if (!row) return err("no such branch variable", 404);
    const body = await readBody(request);
    const fields = pickText(body, { notes: NOTES_MAX });
    if (body.key !== undefined) fields.key = parseKey(body.key);
    const stmts = [];
    if (body.value !== undefined) {
      const value = String(body.value ?? "");
      stmts.push(...(await historyStmts(env, branchOwner(branchId, oldKey), row.enc_blob, value)));
      fields.enc_blob = await encryptValue(env, value);
    }
    fields.updated_at = now();
    const set = setClause(fields);
    stmts.push(
      env.DB.prepare(`UPDATE branch_vars SET ${set.sql} WHERE branch_id = ?${set.next} AND key = ?${set.next + 1}`).bind(...set.values, branchId, oldKey)
    );
    if (fields.key && fields.key !== oldKey) {
      stmts.push(
        env.DB.prepare("UPDATE value_history SET owner = ?2 WHERE owner = ?1").bind(branchOwner(branchId, oldKey), branchOwner(branchId, fields.key))
      );
    }
    try {
      await env.DB.batch(stmts);
    } catch (e) {
      if (isUniqueError(e)) return err(`this branch already has ${fields.key}`, 409);
      throw e;
    }
    return json({ ok: true, key: fields.key ?? oldKey });
  }

  if (branchVarMatch && method === "DELETE") {
    const branchId = decodeURIComponent(branchVarMatch[1]);
    const key = decodeURIComponent(branchVarMatch[2]);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM value_history WHERE owner = ?1").bind(branchOwner(branchId, key)),
      env.DB.prepare("DELETE FROM branch_vars WHERE branch_id = ?1 AND key = ?2").bind(branchId, key),
    ]);
    return json({ ok: true });
  }

  const branchMatch = pathname.match(/^\/api\/branches\/([^/]+)$/);
  if (branchMatch && method === "GET") {
    return json(await branchDetail(env, await findBranch(env, decodeURIComponent(branchMatch[1]))));
  }

  // Partial edit: name, notes. Renaming changes what `envvault run -b` must be called with.
  if (branchMatch && method === "PATCH") {
    const branch = await findBranch(env, decodeURIComponent(branchMatch[1]));
    const body = await readBody(request);
    const fields = pickText(body, { notes: NOTES_MAX });
    if (body.name !== undefined) fields.name = parseBranchName(body.name);
    fields.updated_at = now();
    const set = setClause(fields);
    try {
      await env.DB.prepare(`UPDATE branches SET ${set.sql} WHERE id = ?${set.next}`).bind(...set.values, branch.id).run();
    } catch (e) {
      if (isUniqueError(e)) return err(`this project already has a branch ${fields.name}`, 409);
      throw e;
    }
    return json({ ok: true, id: branch.id, name: fields.name ?? branch.name });
  }

  if (branchMatch && method === "DELETE") {
    const id = decodeURIComponent(branchMatch[1]);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM value_history WHERE owner LIKE 'branch:%' AND substr(owner, 8, 36) = ?1").bind(id),
      env.DB.prepare("DELETE FROM branch_vars WHERE branch_id = ?1").bind(id),
      env.DB.prepare("DELETE FROM branches WHERE id = ?1").bind(id),
    ]);
    return json({ ok: true });
  }

  // ---- personal items: logins, secure notes, secrets ----

  if (pathname === "/api/items" && method === "GET") {
    const rows = await env.DB.prepare(
      "SELECT i.id, i.type, i.title, i.url, i.username, i.notes, i.project_id, p.name AS project, i.created_at, i.updated_at " +
        "FROM items i LEFT JOIN projects p ON p.id = i.project_id ORDER BY i.title COLLATE NOCASE"
    ).all();
    return json(rows.results);
  }

  // {type: login|note|secret, title, value, url?, username?, notes?, project_id?}
  if (pathname === "/api/items" && method === "POST") {
    const body = await readBody(request);
    const type = String(body.type ?? "");
    if (!ITEM_TYPES.includes(type)) return err(`type must be one of: ${ITEM_TYPES.join(", ")}`);
    const fields = pickText(body, ITEM_TEXT);
    if (!fields.title) return err("title is required");
    const projectId = await parseItemProject(env, body.project_id);
    const id = crypto.randomUUID();
    const ts = now();
    await env.DB.prepare(
      "INSERT INTO items (id, type, title, url, username, enc_blob, notes, project_id, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)"
    ).bind(
      id, type, fields.title, fields.url ?? "", fields.username ?? "",
      await encryptValue(env, String(body.value ?? "")), fields.notes ?? "", projectId ?? null, ts
    ).run();
    return json({ ok: true, id });
  }

  const itemValueMatch = pathname.match(/^\/api\/items\/([^/]+)\/value$/);
  if (itemValueMatch && method === "GET") {
    const row = await env.DB.prepare("SELECT enc_blob FROM items WHERE id = ?1").bind(decodeURIComponent(itemValueMatch[1])).first();
    if (!row) return err("no such item", 404);
    return json({ value: await decryptValue(env, row.enc_blob) }, 200, { "Cache-Control": "no-store" });
  }

  const itemMatch = pathname.match(/^\/api\/items\/([^/]+)$/);
  // Partial edit: any of title, url, username, notes, project_id, value.
  if (itemMatch && method === "PATCH") {
    const id = decodeURIComponent(itemMatch[1]);
    const row = await env.DB.prepare("SELECT enc_blob FROM items WHERE id = ?1").bind(id).first();
    if (!row) return err("no such item", 404);
    const body = await readBody(request);
    const fields = pickText(body, ITEM_TEXT);
    if (fields.title === "") return err("title is required");
    const projectId = await parseItemProject(env, body.project_id);
    if (projectId !== undefined) fields.project_id = projectId;
    const stmts = [];
    if (body.value !== undefined) {
      const value = String(body.value ?? "");
      stmts.push(...(await historyStmts(env, itemOwner(id), row.enc_blob, value)));
      fields.enc_blob = await encryptValue(env, value);
    }
    fields.updated_at = now();
    const set = setClause(fields);
    stmts.push(env.DB.prepare(`UPDATE items SET ${set.sql} WHERE id = ?${set.next}`).bind(...set.values, id));
    await env.DB.batch(stmts);
    return json({ ok: true, id });
  }

  if (itemMatch && method === "DELETE") {
    const id = decodeURIComponent(itemMatch[1]);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM value_history WHERE owner = ?1").bind(itemOwner(id)),
      env.DB.prepare("DELETE FROM items WHERE id = ?1").bind(id),
    ]);
    return json({ ok: true });
  }

  // ---- access log: who pulled or read what, from where (see activity.js) ----

  if (pathname === "/api/activity/summary" && method === "GET") {
    return json(await activitySummary(env, url), 200, { "Cache-Control": "no-store" });
  }

  if (pathname === "/api/activity" && method === "GET") {
    return json(await activityEvents(env, url), 200, { "Cache-Control": "no-store" });
  }

  // ---- value history (the last HISTORY_KEEP replaced values of anything) ----

  // ?owner=var:KEY | branch:BRANCH_ID:KEY | item:ITEM_ID -> [{id, created_at}], newest first, no values.
  if (pathname === "/api/history" && method === "GET") {
    const owner = url.searchParams.get("owner");
    parseOwner(owner);
    const rows = await env.DB.prepare("SELECT id, created_at FROM value_history WHERE owner = ?1 ORDER BY id DESC").bind(owner).all();
    return json(rows.results);
  }

  const historyValueMatch = pathname.match(/^\/api\/history\/(\d+)\/value$/);
  if (historyValueMatch && method === "GET") {
    const row = await env.DB.prepare("SELECT enc_blob FROM value_history WHERE id = ?1").bind(Number(historyValueMatch[1])).first();
    if (!row) return err("no such history entry", 404);
    return json({ value: await decryptValue(env, row.enc_blob) }, 200, { "Cache-Control": "no-store" });
  }

  // Puts an old value back. The value it replaces goes into history, like any change.
  const historyRestoreMatch = pathname.match(/^\/api\/history\/(\d+)\/restore$/);
  if (historyRestoreMatch && method === "POST") {
    const id = Number(historyRestoreMatch[1]);
    const row = await env.DB.prepare("SELECT owner, enc_blob FROM value_history WHERE id = ?1").bind(id).first();
    if (!row) return err("no such history entry", 404);
    const plain = await decryptValue(env, row.enc_blob);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM value_history WHERE id = ?1").bind(id),
      ...(await setValueStmts(env, row.owner, plain)),
    ]);
    return json({ ok: true, owner: row.owner });
  }

  return err("not found", 404);
}

async function apiResponse(request, env, url) {
  try {
    return await handleApi(request, env, url);
  } catch (e) {
    if (e instanceof HttpError) return err(e.message, e.status);
    return err(`internal error: ${e.message}`, 500);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const response = await apiResponse(request, env, url);
      // Recorded after the response is sent, so logging never slows a request down.
      ctx.waitUntil(recordAccess(env, request, url, response));
      return response;
    }
    return env.ASSETS.fetch(request);
  },
};
