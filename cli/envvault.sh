#!/usr/bin/env bash
# envvault - pull decrypted secrets from your personal env-vault at runtime.
# No cloning, no local .env files.
set -euo pipefail

CONFIG_DIR="$HOME/.config/env-vault"
CONFIG_FILE="$CONFIG_DIR/config"
DEFAULT_URL="https://env-vault-api.alexdev93.workers.dev"

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

# GET an API path; on an HTTP error, print the server's message and exit.
api_get() {
  local body status
  body="$(curl -sS -w '\n%{http_code}' "$ENV_VAULT_URL$1" -H "Authorization: Bearer $ENV_VAULT_TOKEN")" || exit 1
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
  mkdir -p "$CONFIG_DIR"
  {
    echo "ENV_VAULT_URL='${url}'"
    echo "ENV_VAULT_TOKEN='${token}'"
  } > "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE"
  echo "saved to $CONFIG_FILE"
}

# Reads the vault's JSON on stdin and prints it as MODE: "exports" (shell export
# lines), "get KEY" (one value), or "keys" (names). Uses node, else python3.
# The key is passed as an argument, never spliced into code.
json_to() {
  if command -v node >/dev/null 2>&1; then
    # shellcheck disable=SC2016  # JS template literal, not shell expansion
    node -e '
      const [mode, key] = process.argv.slice(1);
      const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
      if (mode === "exports") for (const [k, v] of Object.entries(d)) console.log(`export ${k}=${JSON.stringify(String(v))}`);
      else if (mode === "get") process.stdout.write(key in d ? String(d[key]) : "");
      else if (mode === "info") {
        const line = (label, v) => v && console.log(`${label.padEnd(12)}${v}`);
        line("project", d.name); line("description", d.description); line("repo", d.repo_url); line("site", d.site_url);
        if (d.notes) console.log(`\nnotes:\n${d.notes}`);
        console.log(`\nvariables (default): ${d.keys.join(", ") || "none"}`);
        if (d.services.length) console.log("\nservices:");
        for (const s of d.services) {
          console.log(`  ${[s.kind, s.provider].filter(Boolean).join(": ")}`);
          line("    url", s.url); line("    account", s.account); line("    notes", s.notes);
        }
        if (d.branches.length) console.log("\nbranches:");
        for (const b of d.branches) {
          console.log(`  ${b.name}${b.notes ? `  (${b.notes})` : ""}`);
          for (const v of b.vars) console.log(`    ${v.key}${v.overrides ? " (overrides default)" : " (branch only)"}`);
        }
      }
      else console.log(Object.keys(d).join("\n"));
    ' "$@"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c '
import json, shlex, sys
mode, key = (sys.argv[1:] + [""])[:2]
d = json.load(sys.stdin)
if mode == "exports":
    for k, v in d.items(): print(f"export {k}={shlex.quote(str(v))}")
elif mode == "get":
    print(str(d.get(key, "")), end="")
elif mode == "info":
    def line(label, v):
        if v: print(f"{label:<12}{v}")
    line("project", d["name"]); line("description", d["description"]); line("repo", d["repo_url"]); line("site", d["site_url"])
    if d["notes"]: print("\nnotes:\n" + d["notes"])
    print("\nvariables (default): " + (", ".join(d["keys"]) or "none"))
    if d["services"]: print("\nservices:")
    for s in d["services"]:
        print("  " + ": ".join(x for x in (s["kind"], s["provider"]) if x))
        line("    url", s["url"]); line("    account", s["account"]); line("    notes", s["notes"])
    if d["branches"]: print("\nbranches:")
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
  local json exports
  json="$(fetch_env_json "${ARGS[0]}" "$BRANCH")"
  exports="$(printf '%s' "$json" | json_to exports)"
  eval "$exports"
  exec "${REST[@]}"
}

cmd_get() {
  parse_args "$@"
  [ "${#ARGS[@]}" -eq 2 ] && [ "$HAS_DASHDASH" -eq 0 ] || usage
  require_config
  local json; json="$(fetch_env_json "${ARGS[0]}" "$BRANCH")"
  printf '%s' "$json" | json_to get "${ARGS[1]}"
}

cmd_list() {
  parse_args "$@"
  [ "${#ARGS[@]}" -eq 1 ] && [ "$HAS_DASHDASH" -eq 0 ] || usage
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

case "${1:-}" in
  login) cmd_login ;;
  run) shift; cmd_run "$@" ;;
  get) shift; cmd_get "$@" ;;
  list) shift; cmd_list "$@" ;;
  info) shift; cmd_info "$@" ;;
  *) usage ;;
esac
