// Access log: who pulled which project, read which secret, or changed what,
// from where. recordAccess() runs after the response (ctx.waitUntil), so it
// never slows a request down, and it never stores a secret value.

import { checkBearer } from "./crypto.js";

const RETENTION_DAYS = 90;
const TEXT_MAX = 300;

const clip = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, TEXT_MAX);
const dec = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

// What a request was, for the log, or null for requests not worth recording
// (the dashboard browsing names and metadata with its session).
function classify(request, url, status, auth) {
  const { pathname } = url;
  const m = request.method;
  let x;
  if (pathname === "/api/login") return { kind: status === 200 ? "login" : "login_failed" };
  if (pathname === "/api/logout") return null;
  // A rejected request only matters when it presented credentials (a wrong token,
  // a forged or expired cookie). Credential-less 401s are the dashboard asking
  // "am I signed in?" before login, or bare probes: not worth an alarm.
  if (status === 401) {
    const presented = request.headers.get("Authorization") || /ev_session=/.test(request.headers.get("Cookie") || "");
    return presented ? { kind: "auth_failed" } : null;
  }
  if ((x = pathname.match(/^\/api\/projects\/([^/]+)\/env$/)) && m === "GET") {
    return { kind: "env_pull", project: dec(x[1]).toLowerCase(), branch: url.searchParams.get("branch") ?? "" };
  }
  if (m === "GET") {
    if ((x = pathname.match(/^\/api\/vars\/([^/]+)\/value$/))) return { kind: "value_read", target: dec(x[1]) };
    if ((x = pathname.match(/^\/api\/branches\/([^/]+)\/vars\/([^/]+)\/value$/))) return { kind: "value_read", branchId: dec(x[1]), target: dec(x[2]) };
    if ((x = pathname.match(/^\/api\/items\/([^/]+)\/value$/))) return { kind: "value_read", itemId: dec(x[1]) };
    if ((x = pathname.match(/^\/api\/history\/(\d+)\/value$/))) return { kind: "value_read", target: `earlier value #${x[1]}` };
    if (pathname === "/api/token") return { kind: "token_read", target: "API token" };
  }
  const projectRef = (x = pathname.match(/^\/api\/projects\/([^/]+)/)) ? dec(x[1]) : "";
  if (m !== "GET") return { kind: "write", projectRef };
  if (auth === "bearer") return { kind: "api_read", projectRef };
  return null;
}

/** Records one API request in access_log if it's worth recording. Call via ctx.waitUntil. */
export async function recordAccess(env, request, url, response) {
  try {
    const status = response.status;
    const auth = checkBearer(request, env) ? "bearer" : /ev_session=/.test(request.headers.get("Cookie") || "") && status !== 401 ? "session" : "none";
    const c = classify(request, url, status, auth);
    if (!c) return;

    let { project = "", branch = "", target = "" } = c;
    let varsCount = null;
    // Name things the way you'd recognise them, not by ids.
    if (c.projectRef) {
      const p = await env.DB.prepare("SELECT name FROM projects WHERE id = ?1 OR name = lower(?1)").bind(c.projectRef).first();
      project = p?.name ?? c.projectRef;
    }
    if (c.branchId) {
      const b = await env.DB.prepare("SELECT b.name, p.name AS project FROM branches b JOIN projects p ON p.id = b.project_id WHERE b.id = ?1")
        .bind(c.branchId).first();
      if (b) ({ name: branch, project } = b);
    }
    if (c.itemId) {
      const it = await env.DB.prepare("SELECT i.title, p.name AS project FROM items i LEFT JOIN projects p ON p.id = i.project_id WHERE i.id = ?1")
        .bind(c.itemId).first();
      target = it?.title ?? c.itemId;
      project = it?.project ?? "";
    }
    if (c.kind === "env_pull" && status === 200) {
      varsCount = Object.keys(await response.clone().json().catch(() => ({}))).length;
    }
    if (c.kind === "write") {
      const body = await response.clone().json().catch(() => ({}));
      target = `${request.method} ${url.pathname.replace(/^\/api\//, "")}${body.key ? ` → ${body.key}` : body.name && !c.projectRef ? ` → ${body.name}` : ""}`;
    }

    const h = request.headers;
    const cf = request.cf || {};
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO access_log (at, kind, method, path, status, auth, project, branch, target, vars_count, " +
          "client, host, ci, command, ip, country, city, as_org, colo, user_agent) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)"
      ).bind(
        new Date().toISOString(), c.kind, request.method, clip(url.pathname), status, auth,
        clip(project), clip(branch), clip(target), varsCount,
        clip(h.get("X-EnvVault-Client")), clip(h.get("X-EnvVault-Host")), clip(h.get("X-EnvVault-CI")), clip(h.get("X-EnvVault-Command")),
        clip(h.get("CF-Connecting-IP")), clip(cf.country), clip(cf.city), clip(cf.asOrganization), clip(cf.colo), clip(h.get("User-Agent"))
      ),
      env.DB.prepare("DELETE FROM access_log WHERE at < ?1").bind(daysAgo(RETENTION_DAYS)),
    ]);
  } catch (e) {
    // Logging must never break a request; surface it in `wrangler tail` only.
    console.error("access log failed:", e.message);
  }
}

// Who a caller is, as best we know: the name it gave, else its hostname, else its IP.
const WHO = "coalesce(nullif(client, ''), nullif(host, ''), ip)";

/** GET /api/activity/summary?days=30&project=NAME: the report page's numbers. */
export async function activitySummary(env, url) {
  const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 30));
  const project = (url.searchParams.get("project") || "").toLowerCase();
  const from = daysAgo(days);
  const d1 = daysAgo(1);
  // Sparklines cover the last 14 days, or the whole range when it's shorter.
  const sparkFrom = days < 14 ? from : daysAgo(14);
  // ?3 is the optional project filter: '' means every project.
  const scope = "at >= ?1 AND (?3 = '' OR project = ?3)";

  const [totals, daily, projects, projectDaily, clients] = await Promise.all([
    env.DB.prepare(
      `SELECT count(*) FILTER (WHERE kind = 'env_pull') AS pulls,
              count(*) FILTER (WHERE kind = 'env_pull' AND at >= ?2) AS pulls_24h,
              count(*) FILTER (WHERE kind IN ('value_read', 'token_read')) AS reads,
              count(*) FILTER (WHERE kind = 'write') AS writes,
              count(*) FILTER (WHERE kind IN ('auth_failed', 'login_failed')) AS failures,
              count(DISTINCT CASE WHEN kind = 'env_pull' THEN ${WHO} END) AS clients
       FROM access_log WHERE ${scope}`
    ).bind(from, d1, project).first(),
    env.DB.prepare(
      `SELECT substr(at, 1, 10) AS day, count(*) AS pulls FROM access_log
       WHERE kind = 'env_pull' AND ${scope} GROUP BY day ORDER BY day`
    ).bind(from, d1, project).all(),
    // The latest pull per project: SQLite takes bare columns from the max(at) row.
    env.DB.prepare(
      `SELECT project, max(at) AS last_at, ${WHO} AS last_client, ip AS last_ip, country AS last_country, ci AS last_ci,
              branch AS last_branch, status AS last_status,
              count(*) AS pulls, count(*) FILTER (WHERE at >= ?2) AS pulls_24h, count(DISTINCT ${WHO}) AS clients
       FROM access_log WHERE kind = 'env_pull' AND ${scope} GROUP BY project ORDER BY last_at DESC`
    ).bind(from, d1, project).all(),
    env.DB.prepare(
      `SELECT project, substr(at, 1, 10) AS day, count(*) AS pulls FROM access_log
       WHERE kind = 'env_pull' AND at >= ?2 AND (?3 = '' OR project = ?3) GROUP BY project, day`
    ).bind(from, sparkFrom, project).all(),
    env.DB.prepare(
      `SELECT ${WHO} AS client, max(at) AS last_at, host, ci, ip, country, city, as_org, user_agent, auth,
              count(*) AS requests, count(*) FILTER (WHERE kind = 'env_pull') AS pulls,
              group_concat(DISTINCT nullif(project, '')) AS projects
       FROM access_log WHERE auth = 'bearer' AND ${scope} GROUP BY ${WHO} ORDER BY last_at DESC LIMIT 100`
    ).bind(from, d1, project).all(),
  ]);

  const sparkByProject = {};
  for (const r of projectDaily.results) (sparkByProject[r.project] ||= []).push({ day: r.day, pulls: r.pulls });
  return {
    days,
    from,
    project,
    totals,
    daily: daily.results,
    projects: projects.results.map((p) => ({ ...p, daily: sparkByProject[p.project] ?? [] })),
    clients: clients.results.map((c) => ({ ...c, projects: c.projects ? c.projects.split(",").sort() : [] })),
  };
}

/** GET /api/activity?project=&kind=&client=&before=ID&limit=50: the event log, newest first. */
export async function activityEvents(env, url) {
  const p = url.searchParams;
  const limit = Math.min(200, Math.max(1, Number(p.get("limit")) || 50));
  const before = Number(p.get("before")) || Number.MAX_SAFE_INTEGER;
  const kinds = (p.get("kind") || "").split(",").filter(Boolean);
  const rows = await env.DB.prepare(
    `SELECT id, at, kind, method, path, status, auth, project, branch, target, vars_count, ${WHO} AS who,
            client, host, ci, command, ip, country, city, as_org, colo, user_agent
     FROM access_log
     WHERE id < ?1 AND (?2 = '' OR project = ?2) AND (?3 = '' OR instr(',' || ?3 || ',', ',' || kind || ',') > 0)
       AND (?4 = '' OR ${WHO} = ?4)
     ORDER BY id DESC LIMIT ?5`
  ).bind(before, (p.get("project") || "").toLowerCase(), kinds.join(","), p.get("client") || "", limit).all();
  return { events: rows.results, next: rows.results.length === limit ? rows.results[rows.results.length - 1].id : null };
}
