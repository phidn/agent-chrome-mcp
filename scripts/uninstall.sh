#!/bin/bash
set -e

# Uninstall script for Agent Chrome MCP.
# Removes the native messaging host manifests (Chrome, Edge, Brave) and the
# wrapper script created by install.sh.
#
# Usage: ./scripts/uninstall.sh
#
# This reverses install.sh. It does NOT remove the MCP server from an MCP client
# or unload the browser extension — those are manual steps printed at the end.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST_DIR="$REPO_ROOT/host"
NATIVE_HOST_PATH="$HOST_DIR/native-host-wrapper.sh"
HOST_NAME="com.philoha.agent_chrome_mcp"

removed_any=false

# Remove a single browser's native messaging host manifest
remove_host() {
  local browser_name="$1"
  local host_dir="$2"
  local manifest="$host_dir/$HOST_NAME.json"

  if [ -f "$manifest" ]; then
    rm -f "$manifest"
    echo "  Removed $browser_name: $manifest"
    removed_any=true
  fi
}

echo ""
echo "Uninstalling native messaging host: $HOST_NAME"
echo ""

case "$(uname)" in
  Darwin)
    remove_host "Google Chrome" \
      "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    remove_host "Microsoft Edge" \
      "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
    remove_host "Brave Browser" \
      "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    ;;
  Linux)
    remove_host "Google Chrome" \
      "$HOME/.config/google-chrome/NativeMessagingHosts"
    remove_host "Microsoft Edge" \
      "$HOME/.config/microsoft-edge/NativeMessagingHosts"
    remove_host "Brave Browser" \
      "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    ;;
  *)
    echo "Error: Unsupported platform $(uname). This script supports macOS and Linux."
    exit 1
    ;;
esac

# Remove the wrapper script created by install.sh
if [ -f "$NATIVE_HOST_PATH" ]; then
  rm -f "$NATIVE_HOST_PATH"
  echo "  Removed wrapper: $NATIVE_HOST_PATH"
  removed_any=true
fi

if [ "$removed_any" = false ]; then
  echo "  Nothing to remove (already uninstalled)."
fi

# Stop any running mcp-server processes (ignore if none)
pkill -f "node.*$HOST_DIR/mcp-server.js" 2>/dev/null && \
  echo "  Stopped running mcp-server process(es)." || true

echo ""
echo "Done! Manual steps to finish removal:"
echo ""
echo "  1. Remove the MCP server from each client where you added it:"
echo ""
echo "     Claude Code:  claude mcp remove agent-chrome-mcp -s user"
echo "     Codex:        codex mcp remove agent-chrome-mcp"
echo "     Antigravity:  Remove 'agent-chrome-mcp' entry from mcp_config.json"
echo ""
echo "  2. Unload the extension at chrome://extensions (Remove)."
echo "  3. Restart your browser (close all windows and reopen)."
echo ""
