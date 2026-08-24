#!/bin/bash
set -e

# Launch a Chromium browser with --silent-debugger-extension-api so Chrome
# doesn't show the "Agent Chrome MCP started debugging this browser" banner.
#
# Usage: ./scripts/chrome-mcp.sh [app-name]
#   ./scripts/chrome-mcp.sh                  # Google Chrome (default)
#   ./scripts/chrome-mcp.sh "Brave Browser"
#   ./scripts/chrome-mcp.sh "Microsoft Edge"
#
# Note: the flag only takes effect on a fresh launch. If the browser is already
# running without it, quit it completely (Cmd+Q) first.

FLAG="--silent-debugger-extension-api"

case "$(uname)" in
  Darwin)
    APP="${1:-Google Chrome}"
    open -a "$APP" --args "$FLAG"
    ;;
  Linux)
    BIN="${1:-google-chrome}"
    nohup "$BIN" "$FLAG" >/dev/null 2>&1 &
    ;;
  *)
    echo "Error: Unsupported platform $(uname). This script supports macOS and Linux."
    exit 1
    ;;
esac
