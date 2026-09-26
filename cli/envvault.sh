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
  envvault run PROJECT -- CMD run CMD with PROJECT's variables injected
  envvault get PROJECT KEY    print one decrypted value
  envvault list PROJECT       list variable names for PROJECT (not values)
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

fetch_env_json() {
  local project="$1"
  curl -fsS "$ENV_VAULT_URL/api/projects/$project/env" -H "Authorization: Bearer $ENV_VAULT_TOKEN"
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
else:
    print("\n".join(d.keys()))
' "$@"
  else
    echo "envvault: needs node or python3 on PATH to parse the response" >&2
    exit 1
  fi
}

cmd_run() {
  if [ $# -lt 3 ] || [ "$2" != "--" ]; then usage; fi
  local project="$1"; shift 2
  require_config
  local exports; exports="$(fetch_env_json "$project" | json_to exports)"
  eval "$exports"
  exec "$@"
}

cmd_get() {
  [ $# -eq 2 ] || usage
  require_config
  fetch_env_json "$1" | json_to get "$2"
}

cmd_list() {
  [ $# -eq 1 ] || usage
  require_config
  fetch_env_json "$1" | json_to keys
}

case "${1:-}" in
  login) cmd_login ;;
  run) shift; cmd_run "$@" ;;
  get) shift; cmd_get "$@" ;;
  list) shift; cmd_list "$@" ;;
  *) usage ;;
esac
