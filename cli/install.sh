#!/bin/sh
set -e
URL="https://env-vault-api.alexdev93.workers.dev"
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
curl -fsS "$URL/envvault.sh" -o "$BIN_DIR/envvault"
chmod +x "$BIN_DIR/envvault"
echo "installed envvault to $BIN_DIR/envvault"

# envvault is a bash script: Linux, macOS (its built-in bash 3.2 is enough),
# WSL, and Git Bash on Windows. Each needs slightly different setup hints.
case "$(uname -s 2>/dev/null)" in
  MINGW* | MSYS* | CYGWIN*) platform=windows; profile="$HOME/.bashrc" ;;
  Darwin) platform=macos; profile="$HOME/.zshrc" ;;
  *) platform=unix; profile="your shell profile ($HOME/.bashrc or $HOME/.zshrc)" ;;
esac

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "add this to $profile: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

if ! command -v node >/dev/null 2>&1 && ! command -v python3 >/dev/null 2>&1; then
  echo "warning: envvault needs node or python3 on PATH to read the vault's responses; install one of them" >&2
fi

if [ "$platform" = windows ]; then
  echo "Windows: envvault runs in Git Bash (as here) or WSL, not in PowerShell or cmd."
  echo "npm runs package.json scripts with cmd.exe on Windows; to use envvault in them, run once:"
  printf '%s\n' '  npm config set script-shell "C:\Program Files\Git\bin\bash.exe"'
fi
echo "next: run 'envvault login' (or set ENV_VAULT_TOKEN in CI; ENV_VAULT_CLIENT to name this machine is optional)"
