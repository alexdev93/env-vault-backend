#!/usr/bin/env bash
# Runs the real envvault CLI (unmodified) in the shells and toolboxes it meets
# in practice, against a fake curl that returns hostile values:
#   bash:3.2        macOS's built-in bash, with node and python3
#   bash:5.2        Alpine/busybox with python3 only (Python, Go, Java servers)
#   node:22-alpine  node only (typical Node.js Docker images)
# Needs Docker. Usage: npm run test:platforms
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cli="$(cd "$here/../cli" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp -R "$here/platforms/." "$work/"
failed=0
run() {
  local name="$1" image="$2" setup="$3"
  echo "=== $name ($image)"
  # The tests run as root in the container; hand the files back so cleanup works.
  if ! docker run --rm -v "$work:/t" -v "$cli:/cli:ro" "$image" \
    sh -c "$setup >/dev/null 2>&1; bash /t/run_tests.sh; rc=\$?; chown -R $(id -u):$(id -g) /t; exit \$rc" | tee "$work/out.txt"; then
    failed=1
  fi
  grep -q " 0 failed" "$work/out.txt" || failed=1
}
run "macOS bash 3.2" bash:3.2 "apk add -q nodejs python3"
run "Alpine, python3 only" bash:5.2 "apk add -q python3"
run "Node image, node only" node:22-alpine "apk add -q bash"
exit "$failed"
