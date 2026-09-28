#!/usr/bin/env bash
# envvault - pull decrypted secrets from your personal env-vault at runtime.
# No cloning, no local .env files.
set -euo pipefail

CONFIG_DIR="$HOME/.config/env-vault"
CONFIG_FILE="$CONFIG_DIR/config"
DEFAULT_URL="https://env-vault-api.alexdev93.workers.dev"
CLI_VERSION="3"
COMMAND=""

usage() {
  cat >&2 <<'EOF'
Usage:
  envvault login              interactively store your vault URL + API token
  envvault run PROJECT [-b BRANCH] -- CMD  run CMD with PROJECT's variables injected
  envvault get PROJECT KEY [-b BRANCH]     print one decrypted value
  envvault list PROJECT [-b BRANCH]        list variable names for PROJECT (not values)
  envvault info PROJECT                    show PROJECT's details, services, branches, notes

Without -b you get the project's default variables. With -b BRANCH, that
branch's overrides are layered on top (the branch must exist in the vault).

The vault's Activity page shows who pulled what. Name each server or CI job
with ENV_VAULT_CLIENT (e.g. ENV_VAULT_CLIENT=cheat-sheet-prod); otherwise the
name saved by `envvault login`, or else the machine's hostname, is used.
EOF
  exit 1
}

require_config() {
  # CI/CD and build environments (GitHub Actions, Vercel, Docker, ...) won't
  # have run `envvault login` -- they set ENV_VAULT_URL/ENV_VAULT_TOKEN as
  # ordinary secrets/env vars instead. Prefer those if already present.
  if [ -n "${ENV_VAULT_TOKEN:-}" ]; then
    : "${ENV_VAULT_URL:=$DEFAULT_URL}"
    return
  fi
  if [ ! -f "$CONFIG_FILE" ]; then
    echo "envvault: not logged in yet. Run: envvault login (or set ENV_VAULT_TOKEN)" >&2
    exit 1
  fi
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
  : "${ENV_VAULT_URL:?missing ENV_VAULT_URL in $CONFIG_FILE}"
  : "${ENV_VAULT_TOKEN:?missing ENV_VAULT_TOKEN in $CONFIG_FILE}"
}

# One line, at most 200 characters: safe to send as an HTTP header value.
oneline() {
  printf '%s' "$1" | tr -d '\r\n' | cut -c1-200
}

# Where this runs, when it's CI or a hosting platform (read from their standard env vars).
ci_info() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    printf 'github-actions %s@%s run %s' "${GITHUB_REPOSITORY:-}" "${GITHUB_REF_NAME:-}" "${GITHUB_RUN_ID:-}"
  elif [ -n "${GITLAB_CI:-}" ]; then
    printf 'gitlab %s@%s job %s' "${CI_PROJECT_PATH:-}" "${CI_COMMIT_REF_NAME:-}" "${CI_JOB_ID:-}"
  elif [ -n "${VERCEL:-}" ]; then
    printf 'vercel %s@%s %s' "${VERCEL_GIT_REPO_SLUG:-}" "${VERCEL_GIT_COMMIT_REF:-}" "${VERCEL_ENV:-}"
  elif [ -n "${CF_PAGES:-}" ]; then
    printf 'cloudflare-pages %s' "${CF_PAGES_BRANCH:-}"
  elif [ -n "${NETLIFY:-}" ]; then
    printf 'netlify %s@%s' "${SITE_NAME:-}" "${BRANCH:-}"
  elif [ -n "${RENDER:-}" ]; then
    printf 'render %s' "${RENDER_SERVICE_NAME:-}"
  elif [ -n "${FLY_APP_NAME:-}" ]; then
    printf 'fly %s %s' "$FLY_APP_NAME" "${FLY_REGION:-}"
  elif [ -n "${RAILWAY_SERVICE_NAME:-}" ]; then
    printf 'railway %s %s' "$RAILWAY_SERVICE_NAME" "${RAILWAY_ENVIRONMENT_NAME:-}"
  elif [ -n "${KUBERNETES_SERVICE_HOST:-}" ]; then
    printf 'kubernetes'
  elif [ -f /.dockerenv ]; then
    printf 'docker'
  elif [ -n "${CI:-}" ]; then
    printf 'ci'
  fi
}

# GET an API path; on an HTTP error, print the server's message and exit.
# It tells the vault who is asking (never anything secret) for the Activity page.
api_get() {
  local body status host client
  host="${HOSTNAME:-$(uname -n 2>/dev/null || echo unknown)}"
  client="${ENV_VAULT_CLIENT:-${ENV_VAULT_CLIENT_NAME:-$host}}"
  body="$(curl -sS -w '\n%{http_code}' "$ENV_VAULT_URL$1" \
    -H "Authorization: Bearer $ENV_VAULT_TOKEN" \
    -H "User-Agent: envvault-cli/$CLI_VERSION ($(uname -s 2>/dev/null || echo unknown))" \
    -H "X-EnvVault-Client: $(oneline "$client")" \
    -H "X-EnvVault-Host: $(oneline "$host")" \
    -H "X-EnvVault-CI: $(oneline "$(ci_info)")" \
    -H "X-EnvVault-Command: $COMMAND")" || exit 1
  status="${body##*$'\n'}"
  body="${body%$'\n'*}"
  if [ "${status:0:1}" != "2" ]; then
    echo "envvault: HTTP $status: $body" >&2
    exit 1
  fi
  printf '%s' "$body"
}

fetch_env_json() {
  local project="$1" branch="${2:-}"
  if [ -n "$branch" ]; then
    api_get "/api/projects/$project/env?branch=$branch"
  else
    api_get "/api/projects/$project/env"
  fi
}

# Splits "$@" into BRANCH (from -b/--branch) and ARGS (everything else), stopping at "--".
# REST holds whatever follows "--", if present.
BRANCH=""
ARGS=()
REST=()
HAS_DASHDASH=0
parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      -b|--branch)
        [ $# -ge 2 ] || usage
        BRANCH="$2"; shift 2 ;;
      --branch=*) BRANCH="${1#--branch=}"; shift ;;
      --) HAS_DASHDASH=1; shift; REST=("$@"); return ;;
      *) ARGS+=("$1"); shift ;;
    esac
  done
}

cmd_login() {
  read -r -p "env-vault URL [$DEFAULT_URL]: " url
  url="${url:-$DEFAULT_URL}"
  read -r -s -p "API token: " token
  echo
  local host="${HOSTNAME:-$(uname -n 2>/dev/null || echo unknown)}"
  read -r -p "Name this machine for the vault's Activity page [$host]: " name
  name="$(printf '%s' "${name:-$host}" | tr -cd 'A-Za-z0-9._ -')"
  mkdir -p "$CONFIG_DIR"
  {
    echo "ENV_VAULT_URL='${url}'"
    echo "ENV_VAULT_TOKEN='${token}'"
    echo "ENV_VAULT_CLIENT_NAME='${name}'"
  } > "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE"
  echo "saved to $CONFIG_FILE"
}

# Reads the vault's JSON on stdin and prints it as MODE: "env0" (KEY NUL VALUE NUL
# pairs, for cmd_run to export as data), "get KEY" (one value), "keys" (names) or
# "info". Uses node, else python3. The key is passed as an argument, never spliced
# into code, and no mode ever produces shell code.
json_to() {
  if command -v node >/dev/null 2>&1; then
    # shellcheck disable=SC2016  # JS template literal, not shell expansion
    node -e '
      const [mode, key] = process.argv.slice(1);
      const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
      if (mode === "env0") {
        for (const [k, v] of Object.entries(d)) {
          // An environment variable cannot hold a NUL byte, and it would break the pairing.
          if (String(v).includes("\0")) { process.stderr.write(`envvault: ${k} contains a NUL byte and cannot be exported\n`); process.exit(1); }
          process.stdout.write(k + "\0" + String(v) + "\0");
        }
      }
      else if (mode === "get") process.stdout.write(key in d ? String(d[key]) : "");
      else if (mode === "info") {
        const line = (label, v) => v && console.log(`${label.padEnd(14)}${v}`);
        line("project", d.name); line("status", d.status); line("description", d.description);
        line("stack", d.stack); line("site", d.site_url); line("repo", d.repo_url);
        for (const x of d.details ?? []) line(x.label, x.value);
        if (d.notes) console.log(`\nnotes:\n${d.notes}`);
        console.log(`\nvariables (default): ${d.keys.join(", ") || "none"}`);
        if (d.services.length) console.log("\nservices:");
        for (const s of d.services) {
          console.log(`  ${[s.kind, s.provider, s.name].filter(Boolean).join(" · ")}`);
          line("    url", s.url); line("    account", s.account);
          line("    region", s.region); line("    plan", s.plan);
          line("    provides", (s.var_keys ?? []).join(", ")); line("    notes", s.notes);
        }
        if (d.branches.length) console.log("\nbranches (use with -b):");
        for (const b of d.branches) {
          console.log(`  ${b.name}${b.notes ? `  (${b.notes})` : ""}`);
          for (const v of b.vars) console.log(`    ${v.key}${v.overrides ? " (overrides default)" : " (branch only)"}`);
        }
      }
      else console.log(Object.keys(d).join("\n"));
    ' "$@"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c '
import json, sys
mode, key = (sys.argv[1:] + [""])[:2]
d = json.load(sys.stdin)
if mode == "env0":
    for k, v in d.items():
        if "\0" in str(v):
            sys.stderr.write("envvault: " + k + " contains a NUL byte and cannot be exported\n"); sys.exit(1)
        sys.stdout.write(k + "\0" + str(v) + "\0")
elif mode == "get":
    print(str(d.get(key, "")), end="")
elif mode == "info":
    def line(label, v):
        if v: print(f"{label:<14}{v}")
    line("project", d["name"]); line("status", d.get("status")); line("description", d["description"])
    line("stack", d.get("stack")); line("site", d["site_url"]); line("repo", d["repo_url"])
    for x in d.get("details") or []: line(x["label"], x["value"])
    if d["notes"]: print("\nnotes:\n" + d["notes"])
    print("\nvariables (default): " + (", ".join(d["keys"]) or "none"))
    if d["services"]: print("\nservices:")
    for s in d["services"]:
        print("  " + " · ".join(x for x in (s["kind"], s["provider"], s.get("name")) if x))
        line("    url", s["url"]); line("    account", s["account"])
        line("    region", s.get("region")); line("    plan", s.get("plan"))
        line("    provides", ", ".join(s.get("var_keys") or [])); line("    notes", s["notes"])
    if d["branches"]: print("\nbranches (use with -b):")
    for b in d["branches"]:
        print("  " + b["name"] + ("  (" + b["notes"] + ")" if b["notes"] else ""))
        for v in b["vars"]: print("    " + v["key"] + (" (overrides default)" if v["overrides"] else " (branch only)"))
else:
    print("\n".join(d.keys()))
' "$@"
  else
    echo "envvault: needs node or python3 on PATH to parse the response" >&2
    exit 1
  fi
}

cmd_run() {
  parse_args "$@"
  if [ "${#ARGS[@]}" -ne 1 ] || [ "$HAS_DASHDASH" -ne 1 ] || [ "${#REST[@]}" -eq 0 ]; then usage; fi
  require_config
  local json key value
  json="$(fetch_env_json "${ARGS[0]}" "$BRANCH")"
  # Parse once up front so a problem (bad JSON, no node/python, a NUL byte) stops
  # here instead of starting the app without its variables.
  printf '%s' "$json" | json_to env0 >/dev/null
  # Each value is exported as data, never evaluated as shell code: $, backticks,
  # $(...), quotes, backslashes and newlines all reach the app unchanged.
  while IFS= read -r -d '' key && IFS= read -r -d '' value; do
    if [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      echo "envvault: skipping invalid variable name: $key" >&2
      continue
    fi
    export "$key=$value"
  done < <(printf '%s' "$json" | json_to env0)
  exec "${REST[@]}"
}

cmd_get() {
  parse_args "$@"
  if [ "${#ARGS[@]}" -ne 2 ] || [ "$HAS_DASHDASH" -ne 0 ]; then usage; fi
  require_config
  local json; json="$(fetch_env_json "${ARGS[0]}" "$BRANCH")"
  printf '%s' "$json" | json_to get "${ARGS[1]}"
}

cmd_list() {
  parse_args "$@"
  if [ "${#ARGS[@]}" -ne 1 ] || [ "$HAS_DASHDASH" -ne 0 ]; then usage; fi
  require_config
  local json; json="$(fetch_env_json "${ARGS[0]}" "$BRANCH")"
  printf '%s' "$json" | json_to keys
}

cmd_info() {
  [ $# -eq 1 ] || usage
  require_config
  local json; json="$(api_get "/api/projects/$1")"
  printf '%s' "$json" | json_to info
}

COMMAND="${1:-}"
case "${1:-}" in
  login) cmd_login ;;
  run) shift; cmd_run "$@" ;;
  get) shift; cmd_get "$@" ;;
  list) shift; cmd_list "$@" ;;
  info) shift; cmd_info "$@" ;;
  *) usage ;;
esac
