#!/bin/sh
set -e
URL="https://env-vault-api.alexdev93.workers.dev"
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
curl -fsS "$URL/envvault.sh" -o "$BIN_DIR/envvault"
chmod +x "$BIN_DIR/envvault"
echo "installed envvault to $BIN_DIR/envvault"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "add this to your shell profile: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
echo "next: run 'envvault login'"
