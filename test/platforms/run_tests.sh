#!/usr/bin/env bash
# Runs inside each container from test/platforms.sh. /t = this directory,
# /cli = backend/cli (the real, unmodified script). fakebin/curl stands in for
# the vault: it records the headers sent and returns hostile.json.
# Each check's condition is single-quoted on purpose and evaluated by ok().
# shellcheck disable=SC2016
set -u
pass=0; fail=0
ok() { if eval "$2"; then echo "  ✓ $1"; pass=$((pass+1)); else echo "  ✗ $1"; fail=$((fail+1)); fi; }
export PATH="/t/fakebin:$PATH" HOME=/t/home ENV_VAULT_URL=http://vault ENV_VAULT_TOKEN=tok
mkdir -p "$HOME"; rm -f /t/pwned
echo "bash $BASH_VERSION on $(uname -s) · node: $(command -v node >/dev/null && node --version || echo none) · python3: $(command -v python3 >/dev/null && echo yes || echo none)"
PY=$(command -v python3 || true)
if [ -n "$PY" ]; then
  out=$(bash /cli/envvault.sh run proj -- "$PY" /t/check.py /t/hostile.json 2>&1)
  ok "run: hostile values arrive unchanged ($out)" '[ "$out" = "all 9 values identical" ]'
fi
ok "run: nothing inside a value executed" '[ ! -e /t/pwned ]'
out=$(bash /cli/envvault.sh run proj -b main -- sh -c 'printf %s "$DOLLAR"' 2>&1)
ok "run -b main -- sh -c … ($out)" '[ "$out" = "pa\$word\$1\${HOME}" ]'
ok "no client name set: falls back to the hostname" 'grep -q "^X-EnvVault-Client: .\+" /t/curl_args && grep -q "^X-EnvVault-Command: run" /t/curl_args'
ENV_VAULT_CLIENT=my-server bash /cli/envvault.sh list proj >/dev/null 2>&1
ok "ENV_VAULT_CLIENT is sent when set" 'grep -q "^X-EnvVault-Client: my-server$" /t/curl_args'
out=$(bash /cli/envvault.sh get proj EMPTY 2>&1; echo "rc=$?")
ok "get of an empty value ($out)" '[ "$out" = "rc=0" ]'
ok "list prints keys" '[ "$(bash /cli/envvault.sh list proj | wc -l | tr -d " ")" = 9 ]'
ok "usage on bad args (exit 1)" '! bash /cli/envvault.sh run proj 2>/dev/null'
# login: old-style 2-line scripted input must still save a working config (no name line)
unset ENV_VAULT_TOKEN
printf 'http://vault\nsecret-tok\n' | bash /cli/envvault.sh login >/dev/null 2>&1
ok "login with only URL + token piped in still saves" 'grep -q "ENV_VAULT_TOKEN=.secret-tok." $HOME/.config/env-vault/config && ! grep -q CLIENT_NAME $HOME/.config/env-vault/config'
printf 'http://vault\nsecret-tok\nlaptop 1\n' | bash /cli/envvault.sh login >/dev/null 2>&1
ok "login with a name saves it" 'grep -q "ENV_VAULT_CLIENT_NAME=.laptop 1." $HOME/.config/env-vault/config'
bash /cli/envvault.sh list proj >/dev/null 2>&1
ok "config-file login + saved name is used" 'grep -q "^X-EnvVault-Client: laptop 1$" /t/curl_args'
printf "ENV_VAULT_URL='http://vault'\nENV_VAULT_TOKEN='tok'\n" > $HOME/.config/env-vault/config
out=$(bash /cli/envvault.sh list proj 2>&1 | wc -l | tr -d " ")
ok "an old config file without a name still works ($out keys)" '[ "$out" = 9 ]'
echo "  → $pass passed, $fail failed"
