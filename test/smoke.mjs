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
  execFileSync(...wrangler(["d1", "execute", "env-vault-db", "--local", "--file=schema.sql"], { stdio: "ignore" }));

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
  check("GET /api/vars decrypts it back exactly", row?.value === secret, JSON.stringify(row));
  check("GET /api/vars links it to the project", row?.projects?.[0] === "smoke-app");

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
