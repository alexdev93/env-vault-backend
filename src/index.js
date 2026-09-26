import {
  encryptValue,
  decryptValue,
  safeEqual,
  createSessionCookie,
  clearSessionCookie,
  isAuthed,
} from "./crypto.js";

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

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

async function listVarsWithProjects(env) {
  const vars = await env.DB.prepare("SELECT key, enc_blob, updated_at FROM vars ORDER BY key").all();
  const links = await env.DB.prepare("SELECT project_id, var_key FROM project_vars").all();
  const projects = await env.DB.prepare("SELECT id, name FROM projects").all();
  const nameById = Object.fromEntries(projects.results.map((p) => [p.id, p.name]));
  const projectsByKey = {};
  for (const l of links.results) {
    (projectsByKey[l.var_key] ||= []).push(nameById[l.project_id]);
  }
  const out = [];
  for (const v of vars.results) {
    out.push({
      key: v.key,
      value: await decryptValue(env, v.enc_blob),
      updated_at: v.updated_at,
      projects: (projectsByKey[v.key] || []).filter(Boolean).sort(),
    });
  }
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

  if (pathname === "/api/vars" && method === "GET") {
    return json(await listVarsWithProjects(env));
  }

  if (pathname === "/api/vars" && method === "POST") {
    const body = await readBody(request);
    const key = String(body.key ?? "").trim();
    if (!KEY_RE.test(key)) return err("key must look like AN_ENV_VAR_NAME");
    const value = body.value ?? "";
    const projectIds = [...new Set(Array.isArray(body.projects) ? body.projects.map(String) : [])];
    const known = new Set((await env.DB.prepare("SELECT id FROM projects").all()).results.map((p) => p.id));
    if (projectIds.some((id) => !known.has(id))) return err("unknown project id");
    const encBlob = await encryptValue(env, String(value));
    const now = new Date().toISOString();
    // One atomic batch: the value and its project links change together or not at all.
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO vars (key, enc_blob, updated_at) VALUES (?1, ?2, ?3) " +
          "ON CONFLICT(key) DO UPDATE SET enc_blob = ?2, updated_at = ?3"
      ).bind(key, encBlob, now),
      env.DB.prepare("DELETE FROM project_vars WHERE var_key = ?1").bind(key),
      ...projectIds.map((pid) =>
        env.DB.prepare("INSERT INTO project_vars (project_id, var_key) VALUES (?1, ?2)").bind(pid, key)
      ),
    ]);
    return json({ ok: true, key });
  }

  const varMatch = pathname.match(/^\/api\/vars\/([^/]+)$/);
  if (varMatch && method === "DELETE") {
    const key = decodeURIComponent(varMatch[1]);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM project_vars WHERE var_key = ?1").bind(key),
      env.DB.prepare("DELETE FROM vars WHERE key = ?1").bind(key),
    ]);
    return json({ ok: true });
  }

  if (pathname === "/api/projects" && method === "GET") {
    const projects = await env.DB.prepare("SELECT id, name, description, created_at FROM projects ORDER BY name").all();
    const links = await env.DB.prepare("SELECT project_id, var_key FROM project_vars").all();
    const keysByProject = {};
    for (const l of links.results) (keysByProject[l.project_id] ||= []).push(l.var_key);
    return json(projects.results.map((p) => ({ ...p, keys: (keysByProject[p.id] || []).sort() })));
  }

  if (pathname === "/api/projects" && method === "POST") {
    const body = await readBody(request);
    const name = String(body.name ?? "").trim().toLowerCase();
    if (!NAME_RE.test(name)) return err("project name must be lowercase letters, numbers, hyphens");
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    try {
      await env.DB.prepare("INSERT INTO projects (id, name, description, created_at) VALUES (?1, ?2, ?3, ?4)")
        .bind(id, name, String(body.description ?? ""), now)
        .run();
    } catch (e) {
      if (/UNIQUE/i.test(e.message)) return err("a project with that name already exists", 409);
      throw e;
    }
    return json({ ok: true, id, name });
  }

  const projMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projMatch && method === "DELETE") {
    const id = decodeURIComponent(projMatch[1]);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM project_vars WHERE project_id = ?1").bind(id),
      env.DB.prepare("DELETE FROM projects WHERE id = ?1").bind(id),
    ]);
    return json({ ok: true });
  }

  const projEnvMatch = pathname.match(/^\/api\/projects\/([^/]+)\/env$/);
  if (projEnvMatch && method === "GET") {
    const name = decodeURIComponent(projEnvMatch[1]).toLowerCase();
    const project = await env.DB.prepare("SELECT id FROM projects WHERE name = ?1").bind(name).first();
    if (!project) return err("no such project", 404);
    const rows = await env.DB.prepare(
      "SELECT v.key, v.enc_blob FROM vars v JOIN project_vars pv ON pv.var_key = v.key WHERE pv.project_id = ?1"
    ).bind(project.id).all();
    const out = {};
    for (const r of rows.results) out[r.key] = await decryptValue(env, r.enc_blob);
    return json(out);
  }

  return err("not found", 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (e) {
        return err(`internal error: ${e.message}`, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
