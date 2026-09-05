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
  if [ ! -f "$CONFIG_FILE" ]; then
    echo "envvault: not logged in yet. Run: envvault login" >&2
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

cmd_run() {
  local project="$1"; shift
  if [ "${1:-}" != "--" ]; then usage; fi
  shift
  require_config
  local json; json="$(fetch_env_json "$project")"
  if command -v node >/dev/null 2>&1; then
    eval "$(node -e '
      const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
      for (const [k, v] of Object.entries(data)) {
        process.stdout.write(`export ${k}=${JSON.stringify(String(v))}\n`);
      }
    ' <<< "$json")"
  elif command -v python3 >/dev/null 2>&1; then
    eval "$(python3 -c '
import json, sys, shlex
data = json.load(sys.stdin)
for k, v in data.items():
    print(f"export {k}={shlex.quote(str(v))}")
' <<< "$json")"
  else
    echo "envvault: needs node or python3 on PATH to parse the response" >&2
    exit 1
  fi
  exec "$@"
}

cmd_get() {
  local project="$1" key="$2"
  require_config
  fetch_env_json "$project" | { command -v node >/dev/null 2>&1 \
    && node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(d['$key']||'')" \
    || python3 -c "import json,sys;print(json.load(sys.stdin).get('$key',''),end='')"; }
}

cmd_list() {
  local project="$1"
  require_config
  fetch_env_json "$project" | { command -v node >/dev/null 2>&1 \
    && node -e "console.log(Object.keys(JSON.parse(require('fs').readFileSync(0,'utf8'))).join('\n'))" \
    || python3 -c "import json,sys;print('\n'.join(json.load(sys.stdin).keys()))"; }
}

case "${1:-}" in
  login) cmd_login ;;
  run) shift; cmd_run "$@" ;;
  get) shift; cmd_get "$@" ;;
  list) shift; cmd_list "$@" ;;
  *) usage ;;
esac
