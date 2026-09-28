// End-to-end smoke test for the Worker. It starts `wrangler dev` with throwaway
// secrets and a temporary D1 database (never your .dev.vars data, never
// production), then exercises every route the dashboard and the envvault CLI rely on.
//
// `npm test` builds dist/ first if it's missing. The dashboard check only runs
// when dist/ contains the web build (as it does from the env-vault root repo).

import { spawn, execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const PORT = 8788;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRETS = {
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  SESSION_SECRET: randomBytes(32).toString("hex"),
  API_TOKEN: "test-token-" + randomBytes(8).toString("hex"),
  DASHBOARD_PASSWORD: "test-password",
};

const state = mkdtempSync(join(tmpdir(), "env-vault-smoke-"));
const wrangler = (args, opts) => ["npx", ["wrangler", ...args, "--persist-to", state], opts];

let server;
let failures = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) failures++;
}

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      await fetch(BASE + "/");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("wrangler dev did not start within 60s");
}

const json = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

try {
  execFileSync(...wrangler(["d1", "migrations", "apply", "env-vault-db", "--local"], { stdio: "ignore", env: { ...process.env, CI: "true" } }));

  const vars = Object.entries(SECRETS).flatMap(([k, v]) => ["--var", `${k}:${v}`]);
  server = spawn(...wrangler(["dev", "--port", String(PORT), "--ip", "127.0.0.1", ...vars], { stdio: "ignore", detached: true }));
  await waitForServer();

  // static assets
  if (existsSync("dist/index.html")) check("GET / serves the dashboard", (await fetch(BASE + "/")).status === 200);
  else console.log("- GET / skipped (no dashboard in dist/)");
  check("GET /install.sh is served", (await fetch(BASE + "/install.sh")).status === 200);
  check("GET /envvault.sh is served", (await fetch(BASE + "/envvault.sh")).status === 200);

  // auth
  check("GET /api/whoami without auth → 401", (await fetch(BASE + "/api/whoami")).status === 401);
  check("POST /api/login wrong password → 401", (await fetch(BASE + "/api/login", json({ password: "nope" }))).status === 401);
  check("POST /api/login with a null body → 401, not 500",
    (await fetch(BASE + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "null" })).status === 401);
  const login = await fetch(BASE + "/api/login", json({ password: SECRETS.DASHBOARD_PASSWORD }));
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  check("POST /api/login correct password → 200 + session cookie", login.status === 200 && cookie.startsWith("ev_session="));
  const withCookie = (init = {}) => ({ ...init, headers: { ...(init.headers || {}), Cookie: cookie } });
  check("GET /api/whoami with cookie → 200", (await fetch(BASE + "/api/whoami", withCookie())).status === 200);

  // projects + vars (dashboard flow)
  const proj = await (await fetch(BASE + "/api/projects", withCookie(json({ name: "smoke-app", description: "test" })))).json();
  check("POST /api/projects creates a project", proj.ok === true && !!proj.id, JSON.stringify(proj));
  const dup = await fetch(BASE + "/api/projects", withCookie(json({ name: "smoke-app" })));
  check("POST /api/projects duplicate name → 409", dup.status === 409);
  const badKey = await fetch(BASE + "/api/vars", withCookie(json({ key: "1-bad", value: "x" })));
  check("POST /api/vars invalid key → 400", badKey.status === 400);
  const badProj = await fetch(BASE + "/api/vars", withCookie(json({ key: "ORPHAN", value: "x", projects: ["no-such-id"] })));
  check("POST /api/vars unknown project id → 400", badProj.status === 400);

  const secret = "postgres://user:p@ss w/ spaces & ünïcode";
  const saved = await fetch(BASE + "/api/vars", withCookie(json({ key: "SMOKE_URL", value: secret, projects: [proj.id] })));
  check("POST /api/vars saves an encrypted value", saved.status === 200);
  const list = await (await fetch(BASE + "/api/vars", withCookie())).json();
  const row = list.find((v) => v.key === "SMOKE_URL");
  check("GET /api/vars lists names without values", !!row && !("value" in row) && row.type === "var", JSON.stringify(row));
  check("GET /api/vars links it to the project", row?.projects?.[0] === "smoke-app" && row?.shared === false);
  const val = await fetch(BASE + "/api/vars/SMOKE_URL/value", withCookie());
  check("GET /api/vars/:key/value decrypts it back exactly", val.status === 200 && (await val.json()).value === secret);
  check("GET /api/vars/:key/value unknown key → 404", (await fetch(BASE + "/api/vars/NOPE/value", withCookie())).status === 404);
  check("GET /api/vars/:key/value without auth → 401", (await fetch(BASE + "/api/vars/SMOKE_URL/value")).status === 401);

  // CLI flow (bearer token)
  const bearer = { headers: { Authorization: `Bearer ${SECRETS.API_TOKEN}` } };
  const env = await fetch(BASE + "/api/projects/smoke-app/env", bearer);
  check("GET /api/projects/:name/env with bearer → plaintext map", env.status === 200 && (await env.json()).SMOKE_URL === secret);
  check("GET /api/projects/:name/env wrong token → 401",
    (await fetch(BASE + "/api/projects/smoke-app/env", { headers: { Authorization: "Bearer wrong" } })).status === 401);
  check("GET /api/projects/missing/env → 404", (await fetch(BASE + "/api/projects/missing/env", bearer)).status === 404);
  const token = await (await fetch(BASE + "/api/token", withCookie())).json();
  check("GET /api/token returns the API token", token.token === SECRETS.API_TOKEN);

  // the real envvault CLI, as other projects use it
  const cli = (...args) =>
    spawnSync("bash", ["cli/envvault.sh", ...args], {
      encoding: "utf8",
      env: { ...process.env, ENV_VAULT_URL: BASE, ENV_VAULT_TOKEN: SECRETS.API_TOKEN },
    });
  const run = cli("run", "smoke-app", "--", "sh", "-c", 'printf %s "$SMOKE_URL"');
  check("envvault run injects the variable", run.status === 0 && run.stdout === secret, run.stderr);
  check("envvault get prints one value", cli("get", "smoke-app", "SMOKE_URL").stdout === secret);
  check("envvault get with a quote in the key doesn't break", cli("get", "smoke-app", "A'B").status === 0);
  check("envvault list prints key names", cli("list", "smoke-app").stdout.trim() === "SMOKE_URL");
  check("envvault run with missing args prints usage", /Usage:/.test(cli("run", "smoke-app").stderr));

  // Values are exported as data, never run through the shell: $, backticks, $(...),
  // quotes, backslashes and newlines must arrive unchanged, and nothing may execute.
  const marker = join(state, "pwned");
  const hostile = `pa$word$1\${HOME} \`touch ${marker}\` $(touch ${marker}) it's "q" a\\b\\n\nline2  `;
  await fetch(BASE + "/api/vars", withCookie(json({ key: "SMOKE_HOSTILE", value: hostile, projects: [proj.id] })));
  const hostileRun = cli("run", "smoke-app", "--", "node", "-e", "process.stdout.write(process.env.SMOKE_HOSTILE)");
  check("envvault run passes $, backticks, $(), quotes and newlines through unchanged", hostileRun.status === 0 && hostileRun.stdout === hostile,
    JSON.stringify({ got: hostileRun.stdout, err: hostileRun.stderr }));
  check("… and never executes anything inside a value", !existsSync(marker));
  await fetch(BASE + "/api/vars/SMOKE_HOSTILE", withCookie({ method: "DELETE" }));

  // notes, project details, services, branches
  const send = (method, path, body) =>
    fetch(BASE + path, withCookie({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  const getJson = async (path) => (await fetch(BASE + path, withCookie())).json();

  const full = await (await send("POST", "/api/projects", {
    name: "smoke-full",
    description: "API",
    notes: "deploys on push to main",
    site_url: "https://smoke.example.com",
    services: [{ kind: "database", provider: "neon", url: "https://console.neon.tech", account: "me@example.com" }],
    branches: ["main", { name: "feature/x", notes: "preview" }],
  })).json();
  check("POST /api/projects with services + branches", full.ok === true, JSON.stringify(full));
  check("POST /api/projects bad branch name → 400",
    (await send("POST", "/api/projects", { name: "smoke-bad", branches: ["-bad"] })).status === 400);
  let detail = await getJson("/api/projects/smoke-full");
  check("GET /api/projects/:name returns details",
    detail.notes === "deploys on push to main" && detail.services[0]?.provider === "neon" && detail.branches.length === 2,
    JSON.stringify(detail));

  check("PATCH /api/projects/:id edits notes + site",
    (await send("PATCH", `/api/projects/${full.id}`, { notes: "edited", site_url: "https://new.example.com" })).status === 200);
  detail = await getJson(`/api/projects/${full.id}`);
  check("… and keeps the rest", detail.notes === "edited" && detail.description === "API" && detail.name === "smoke-full");
  check("PATCH /api/projects/:id to a taken name → 409", (await send("PATCH", `/api/projects/${full.id}`, { name: "smoke-app" })).status === 409);

  const svc = await (await send("POST", "/api/projects/smoke-full/services", { kind: "hosting", provider: "cloudflare" })).json();
  check("POST /api/projects/:ref/services adds a service", svc.ok === true);
  check("PATCH /api/services/:id edits it", (await send("PATCH", `/api/services/${svc.id}`, { account: "me@example.com" })).status === 200);
  check("POST /api/projects/:ref/services empty → 400", (await send("POST", "/api/projects/smoke-full/services", {})).status === 400);
  check("DELETE /api/services/:id", (await send("DELETE", `/api/services/${svc.id}`)).status === 200);
  check("… leaves one service", (await getJson("/api/projects/smoke-full")).services.length === 1);

  // defaults + a main-branch override + a branch-only key
  await send("POST", "/api/vars", { key: "DB_URL", value: "postgres://default", projects: [full.id], notes: "neon main db" });
  await send("POST", "/api/vars", { key: "LOG_LEVEL", value: "info", projects: [full.id] });
  const mainId = detail.branches.find((b) => b.name === "main").id;
  check("POST /api/branches/:id/vars new key without value → 400", (await send("POST", `/api/branches/${mainId}/vars`, { key: "X" })).status === 400);
  await send("POST", `/api/branches/${mainId}/vars`, { key: "DB_URL", value: "postgres://main", notes: "prod branch" });
  await send("POST", `/api/branches/${mainId}/vars`, { key: "ONLY_MAIN", value: "1" });
  const mainEnv = await getJson("/api/projects/smoke-full/env?branch=main");
  check("GET /env?branch=main layers overrides on defaults",
    mainEnv.DB_URL === "postgres://main" && mainEnv.LOG_LEVEL === "info" && mainEnv.ONLY_MAIN === "1", JSON.stringify(mainEnv));
  const defEnv = await getJson("/api/projects/smoke-full/env");
  check("GET /env without branch is unchanged", defEnv.DB_URL === "postgres://default" && !("ONLY_MAIN" in defEnv));
  check("GET /env?branch=missing → 404", (await fetch(BASE + "/api/projects/smoke-full/env?branch=nope", withCookie())).status === 404);
  const featureEnv = await getJson("/api/projects/smoke-full/env?branch=feature%2Fx");
  check("a branch with no overrides gets the defaults", featureEnv.DB_URL === "postgres://default");
  const mainDetail = await getJson(`/api/branches/${mainId}`);
  check("GET /api/branches/:id marks overrides vs branch-only",
    mainDetail.vars.find((v) => v.key === "DB_URL")?.overrides === true && mainDetail.vars.find((v) => v.key === "ONLY_MAIN")?.overrides === false);
  check("GET /api/branches/:id/vars/:key/value",
    (await getJson(`/api/branches/${mainId}/vars/DB_URL/value`)).value === "postgres://main");
  check("POST branch var without value keeps the value, edits notes",
    (await send("POST", `/api/branches/${mainId}/vars`, { key: "DB_URL", notes: "n2" })).status === 200 &&
      (await getJson(`/api/branches/${mainId}/vars/DB_URL/value`)).value === "postgres://main");

  // CLI with -b, as CI uses it
  const runMain = cli("run", "smoke-full", "-b", "main", "--", "sh", "-c", 'printf %s "$DB_URL"');
  check("envvault run -b main injects the branch value", runMain.status === 0 && runMain.stdout === "postgres://main", runMain.stderr);
  check("envvault run without -b still gets the default",
    cli("run", "smoke-full", "--", "sh", "-c", 'printf %s "$DB_URL"').stdout === "postgres://default");
  check("envvault get -b", cli("get", "smoke-full", "ONLY_MAIN", "--branch", "main").stdout === "1");
  check("envvault list -b includes branch-only keys", cli("list", "-b", "main", "smoke-full").stdout.includes("ONLY_MAIN"));
  const badBranch = cli("run", "smoke-full", "-b", "nope", "--", "true");
  check("envvault run -b unknown branch fails loudly", badBranch.status !== 0 && /no branch nope/.test(badBranch.stderr), badBranch.stderr);
  const info = cli("info", "smoke-full");
  check("envvault info shows services and branches", info.status === 0 && /neon/.test(info.stdout) && /feature\/x/.test(info.stdout), info.stderr);

  // edits: rename a variable (branch overrides follow), rename a branch, var notes
  check("GET /api/vars/:key has notes", (await getJson("/api/vars/DB_URL")).notes === "neon main db");
  check("PATCH /api/vars/:key renames", (await send("PATCH", "/api/vars/DB_URL", { key: "DATABASE_URL", notes: "renamed" })).status === 200);
  const renamedEnv = await getJson("/api/projects/smoke-full/env?branch=main");
  check("… value, links and branch override follow the rename",
    renamedEnv.DATABASE_URL === "postgres://main" && !("DB_URL" in renamedEnv) &&
      (await getJson("/api/projects/smoke-full/env")).DATABASE_URL === "postgres://default", JSON.stringify(renamedEnv));
  check("PATCH /api/vars/:key onto an existing key → 409", (await send("PATCH", "/api/vars/DATABASE_URL", { key: "LOG_LEVEL" })).status === 409);
  check("PATCH /api/vars/:key value only", (await send("PATCH", "/api/vars/LOG_LEVEL", { value: "debug" })).status === 200 &&
    (await getJson("/api/vars/LOG_LEVEL/value")).value === "debug");
  check("PATCH /api/branches/:id renames", (await send("PATCH", `/api/branches/${mainId}`, { name: "production" })).status === 200);
  check("… and -b uses the new name", (await getJson("/api/projects/smoke-full/env?branch=production")).DATABASE_URL === "postgres://main");
  check("PATCH /api/branches/:id/vars/:key renames a branch var",
    (await send("PATCH", `/api/branches/${mainId}/vars/ONLY_MAIN`, { key: "ONLY_PROD" })).status === 200);
  check("DELETE /api/branches/:id/vars/:key", (await send("DELETE", `/api/branches/${mainId}/vars/ONLY_PROD`)).status === 200);
  check("DELETE /api/branches/:id", (await send("DELETE", `/api/branches/${mainId}`)).status === 200);
  check("… the branch is gone", (await fetch(BASE + "/api/projects/smoke-full/env?branch=production", withCookie())).status === 404);
  check("DELETE /api/projects/:name removes its services and branches",
    (await send("DELETE", "/api/projects/smoke-full")).status === 200 && (await getJson("/api/projects")).length === 1);
  for (const k of ["DATABASE_URL", "LOG_LEVEL"]) await send("DELETE", `/api/vars/${k}`);

  // value history: the last 5 replaced values, oldest dropped first
  const hist = async (owner) => getJson(`/api/history?owner=${encodeURIComponent(owner)}`);
  await send("POST", "/api/vars", { key: "HIST_KEY", value: "v0" });
  check("a new variable has no history", (await hist("var:HIST_KEY")).length === 0);
  await send("POST", "/api/vars", { key: "HIST_KEY", value: "v0" });
  check("saving the same value adds no history", (await hist("var:HIST_KEY")).length === 0);
  for (let i = 1; i <= 6; i++) await send("PATCH", "/api/vars/HIST_KEY", { value: `v${i}` });
  let h = await hist("var:HIST_KEY");
  check("history keeps only the last 5 values", h.length === 5, JSON.stringify(h));
  const histValues = [];
  for (const e of h) histValues.push((await getJson(`/api/history/${e.id}/value`)).value);
  check("… newest first, oldest (v0) dropped", histValues.join(",") === "v5,v4,v3,v2,v1", histValues.join(","));
  check("PATCH notes only adds no history",
    (await send("PATCH", "/api/vars/HIST_KEY", { notes: "n" })).status === 200 && (await hist("var:HIST_KEY")).length === 5);
  const restore = await send("POST", `/api/history/${h[3].id}/restore`, {});
  check("POST /api/history/:id/restore puts v2 back",
    restore.status === 200 && (await getJson("/api/vars/HIST_KEY/value")).value === "v2");
  h = await hist("var:HIST_KEY");
  const afterRestore = [];
  for (const e of h) afterRestore.push((await getJson(`/api/history/${e.id}/value`)).value);
  check("… and v6 goes into history in its place", afterRestore.join(",") === "v6,v5,v4,v3,v1", afterRestore.join(","));
  await send("PATCH", "/api/vars/HIST_KEY", { key: "HIST_RENAMED" });
  check("history follows a rename", (await hist("var:HIST_RENAMED")).length === 5 && (await hist("var:HIST_KEY")).length === 0);
  await send("DELETE", "/api/vars/HIST_RENAMED");
  check("deleting a variable deletes its history", (await hist("var:HIST_RENAMED")).length === 0);
  check("GET /api/history bad owner → 400", (await fetch(BASE + "/api/history?owner=nope", withCookie())).status === 400);

  // branch value history, project status/stack/details, services linked to variables
  const hp = await (await send("POST", "/api/projects", {
    name: "smoke-hist", status: "live", stack: "Node 22", branches: ["main"],
    details: [{ label: "Deploy", value: "npm run deploy" }, { label: "", value: "" }],
  })).json();
  check("POST /api/projects with status/stack/details", hp.ok === true, JSON.stringify(hp));
  check("POST /api/projects bad status → 400", (await send("POST", "/api/projects", { name: "smoke-bad2", status: "nope" })).status === 400);
  await send("POST", "/api/vars", { key: "SMOKE_DB", value: "d", projects: [hp.id] });
  let hd = await getJson("/api/projects/smoke-hist");
  check("details are stored as a list, blanks dropped", hd.details.length === 1 && hd.details[0].value === "npm run deploy" && hd.status === "live");
  check("PATCH status + details", (await send("PATCH", "/api/projects/smoke-hist", { status: "maintenance", details: [] })).status === 200 &&
    (await getJson("/api/projects/smoke-hist")).details.length === 0);
  const hsvc = await (await send("POST", "/api/projects/smoke-hist/services", {
    kind: "database", provider: "neon", name: "smoke-db", region: "eu-central-1", plan: "free", var_keys: ["SMOKE_DB"],
  })).json();
  hd = await getJson("/api/projects/smoke-hist");
  check("services store name/region/plan and linked var_keys",
    hd.services[0]?.region === "eu-central-1" && hd.services[0]?.var_keys?.[0] === "SMOKE_DB", JSON.stringify(hd.services));
  check("POST service with a bad var key → 400", (await send("POST", "/api/projects/smoke-hist/services", { kind: "x", var_keys: ["1bad"] })).status === 400);
  await send("PATCH", "/api/vars/SMOKE_DB", { key: "SMOKE_DATABASE" });
  check("service links follow a variable rename",
    (await getJson("/api/projects/smoke-hist")).services[0].var_keys[0] === "SMOKE_DATABASE");
  check("PATCH service var_keys", (await send("PATCH", `/api/services/${hsvc.id}`, { var_keys: [] })).status === 200 &&
    (await getJson("/api/projects/smoke-hist")).services[0].var_keys.length === 0);
  const hMain = hd.branches[0].id;
  await send("POST", `/api/branches/${hMain}/vars`, { key: "SMOKE_DATABASE", value: "b1" });
  await send("POST", `/api/branches/${hMain}/vars`, { key: "SMOKE_DATABASE", value: "b2" });
  await send("PATCH", `/api/branches/${hMain}/vars/SMOKE_DATABASE`, { value: "b3" });
  check("branch values keep history", (await hist(`branch:${hMain}:SMOKE_DATABASE`)).length === 2);
  await send("PATCH", `/api/branches/${hMain}/vars/SMOKE_DATABASE`, { key: "SMOKE_B" });
  check("branch history follows a branch-var rename", (await hist(`branch:${hMain}:SMOKE_B`)).length === 2);
  await send("DELETE", `/api/branches/${hMain}`);
  check("deleting a branch deletes its history", (await hist(`branch:${hMain}:SMOKE_B`)).length === 0);

  // personal items
  const loginItem = await (await send("POST", "/api/items", {
    type: "login", title: "Neon console", url: "console.neon.tech", username: "me@example.com", value: "pw1", project_id: hp.id,
  })).json();
  check("POST /api/items creates a login", loginItem.ok === true, JSON.stringify(loginItem));
  check("POST /api/items bad type → 400", (await send("POST", "/api/items", { type: "card", title: "x", value: "1" })).status === 400);
  check("POST /api/items without title → 400", (await send("POST", "/api/items", { type: "note", value: "1" })).status === 400);
  const items = await getJson("/api/items");
  check("GET /api/items lists metadata, no values, with project name",
    items[0]?.title === "Neon console" && !("value" in items[0]) && !("enc_blob" in items[0]) && items[0].project === "smoke-hist", JSON.stringify(items));
  check("GET /api/items/:id/value", (await getJson(`/api/items/${loginItem.id}/value`)).value === "pw1");
  await send("PATCH", `/api/items/${loginItem.id}`, { value: "pw2", title: "Neon" });
  check("PATCH /api/items/:id value keeps history",
    (await getJson(`/api/items/${loginItem.id}/value`)).value === "pw2" && (await hist(`item:${loginItem.id}`)).length === 1);
  await send("DELETE", "/api/projects/smoke-hist");
  check("deleting a project unlinks its items, keeps them", (await getJson("/api/items"))[0]?.project_id === null);
  check("DELETE /api/items/:id", (await send("DELETE", `/api/items/${loginItem.id}`)).status === 200 &&
    (await getJson("/api/items")).length === 0 && (await hist(`item:${loginItem.id}`)).length === 0);
  await send("DELETE", "/api/vars/SMOKE_DATABASE");

  // access log + activity report
  const actSecret = "act-secret-value-123";
  const act = await (await send("POST", "/api/projects", { name: "smoke-act", branches: ["main"] })).json();
  await send("POST", "/api/vars", { key: "ACT_KEY", value: actSecret, projects: [act.id] });
  const pullAs = spawnSync("bash", ["cli/envvault.sh", "run", "smoke-act", "-b", "main", "--", "true"], {
    encoding: "utf8",
    env: {
      ...process.env, ENV_VAULT_URL: BASE, ENV_VAULT_TOKEN: SECRETS.API_TOKEN, ENV_VAULT_CLIENT: "cheat-sheet-prod",
      GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "me/cheat-sheet", GITHUB_REF_NAME: "main", GITHUB_RUN_ID: "42",
    },
  });
  check("envvault run as a named CI client succeeds", pullAs.status === 0, pullAs.stderr);
  await fetch(BASE + "/api/vars/ACT_KEY/value", withCookie());
  await fetch(BASE + "/api/projects/smoke-act/env", { headers: { Authorization: "Bearer wrong" } });
  const actEvents = async (q = "") => (await getJson(`/api/activity?project=smoke-act${q}`)).events;
  // Logging happens after the response (ctx.waitUntil): give it a moment.
  let evs = [];
  for (let i = 0; i < 40 && evs.filter((e) => ["env_pull", "value_read"].includes(e.kind)).length < 1; i++) {
    await new Promise((r) => setTimeout(r, 250));
    evs = await actEvents();
  }
  const pull = evs.find((e) => e.kind === "env_pull" && e.status === 200);
  check("an env pull is logged with who, where and what",
    pull?.client === "cheat-sheet-prod" && pull.branch === "main" && pull.command === "run" && pull.auth === "bearer" &&
      pull.vars_count === 1 && /^github-actions me\/cheat-sheet@main run 42/.test(pull.ci) && /^envvault-cli\//.test(pull.user_agent),
    JSON.stringify(pull));
  const allEvents = (await getJson("/api/activity?limit=200")).events;
  check("a dashboard reveal is logged as a value read",
    allEvents.some((e) => e.kind === "value_read" && e.target === "ACT_KEY" && e.auth === "session"));
  check("a wrong token is logged as a failed auth", allEvents.some((e) => e.kind === "auth_failed" && e.path === "/api/projects/smoke-act/env"));
  check("a credential-less 401 (the dashboard's whoami probe) is not logged",
    !allEvents.some((e) => e.kind === "auth_failed" && e.path === "/api/whoami"));
  check("browsing lists in the dashboard is not logged", !allEvents.some((e) => e.method === "GET" && e.path === "/api/vars"));
  check("the log never contains a secret value", !JSON.stringify(allEvents).includes(actSecret) && !JSON.stringify(allEvents).includes(SECRETS.API_TOKEN));
  check("GET /api/activity?kind= filters", (await actEvents("&kind=env_pull")).every((e) => e.kind === "env_pull"));
  const summary = await getJson("/api/activity/summary?days=7");
  const actProj = summary.projects?.find((p) => p.project === "smoke-act");
  check("summary: per-project heartbeat", actProj?.pulls >= 1 && actProj.last_client === "cheat-sheet-prod" && actProj.daily.length >= 1,
    JSON.stringify(actProj));
  check("summary: clients and what they pull",
    summary.clients?.some((c) => c.client === "cheat-sheet-prod" && c.projects.includes("smoke-act")), JSON.stringify(summary.clients));
  check("summary: totals and daily pulls", summary.totals?.pulls >= 1 && summary.totals.failures >= 1 && summary.daily?.length >= 1, JSON.stringify(summary.totals));
  check("summary: ?project= scopes it", (await getJson("/api/activity/summary?project=nope")).totals.pulls === 0);
  check("GET /api/activity without auth → 401", (await fetch(BASE + "/api/activity")).status === 401);
  await send("DELETE", "/api/projects/smoke-act");
  await send("DELETE", "/api/vars/ACT_KEY");

  // cleanup routes
  check("DELETE /api/vars/:key → 200", (await fetch(BASE + "/api/vars/SMOKE_URL", withCookie({ method: "DELETE" }))).status === 200);
  check("DELETE /api/projects/:id → 200", (await fetch(BASE + `/api/projects/${proj.id}`, withCookie({ method: "DELETE" }))).status === 200);
  const after = await (await fetch(BASE + "/api/vars", withCookie())).json();
  check("vars list is empty after deletes (no orphan from the rejected save)", Array.isArray(after) && after.length === 0);

  check("POST /api/logout clears the cookie",
    ((await fetch(BASE + "/api/logout", { method: "POST" })).headers.get("set-cookie") || "").includes("Max-Age=0"));
} catch (e) {
  check("smoke test ran to completion", false, e.message);
} finally {
  if (server) process.kill(-server.pid, "SIGTERM");
  rmSync(state, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
