#!/bin/bash
set -e

# Install script for Agent Chrome MCP extension.
# Registers the native messaging host for Chrome, Edge, and Brave.
#
# Usage: ./scripts/install.sh <extension-id> [extension-id-2] [extension-id-3] ...
#
# Pass one extension ID per browser. Each Chromium browser assigns a different
# ID when loading unpacked extensions, so if you use both Chrome and Brave,
# pass both IDs.

if [ -z "$1" ]; then
  echo "Usage: ./scripts/install.sh <extension-id> [extension-id-2] ..."
  echo ""
  echo "Pass one extension ID per browser you want to use."
  echo "Each browser assigns a different ID to the same unpacked extension."
  echo ""
  echo "Steps:"
  echo "  1. Open chrome://extensions (and/or brave://extensions)"
  echo "  2. Enable Developer Mode"
  echo "  3. Click 'Load unpacked' and select the extension/ directory"
  echo "  4. Copy the extension ID shown under the extension name"
  echo "  5. Repeat for each browser"
  echo "  6. Run: ./scripts/install.sh <chrome-id> <brave-id>"
  exit 1
fi

EXTENSION_IDS=("$@")
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST_DIR="$REPO_ROOT/host"
NATIVE_HOST_PATH="$HOST_DIR/native-host-wrapper.sh"
HOST_NAME="com.philoha.agent_chrome_mcp"
NODE_BIN="$(command -v node)"
MCP_SERVER_PATH="$HOST_DIR/mcp-server.js"

# Verify node is available
if ! command -v node &> /dev/null; then
  echo "Error: node is not installed. Install Node.js first."
  exit 1
fi

# Verify npm dependencies are installed
if [ ! -d "$HOST_DIR/node_modules" ]; then
  echo "Installing npm dependencies..."
  cd "$HOST_DIR" && npm install
  cd "$REPO_ROOT"
fi

# Create the native host wrapper script
# Chrome launches this via native messaging — it needs to find node and the script.
cat > "$NATIVE_HOST_PATH" << WRAPPER
#!/bin/sh
exec "$(which node)" "$HOST_DIR/native-host.js"
WRAPPER
chmod +x "$NATIVE_HOST_PATH"

echo "Created native host wrapper: $NATIVE_HOST_PATH"

# Build allowed_origins array from all extension IDs
ORIGINS=""
for i in "${!EXTENSION_IDS[@]}"; do
  if [ $i -gt 0 ]; then ORIGINS="$ORIGINS,"; fi
  ORIGINS="$ORIGINS
    \"chrome-extension://${EXTENSION_IDS[$i]}/\""
done

# Native messaging host manifest
generate_manifest() {
  cat << EOF
{
  "name": "$HOST_NAME",
  "description": "Agent Chrome MCP Native Messaging Host",
  "path": "$NATIVE_HOST_PATH",
  "type": "stdio",
  "allowed_origins": [$ORIGINS
  ]
}
EOF
}

# Platform-specific installation
install_host() {
  local browser_name="$1"
  local host_dir="$2"

  if [ ! -d "$(dirname "$host_dir")" ]; then
    echo "  Skipping $browser_name (not installed)"
    return
  fi

  mkdir -p "$host_dir"
  generate_manifest > "$host_dir/$HOST_NAME.json"
  echo "  Installed for $browser_name: $host_dir/$HOST_NAME.json"
}

echo ""
echo "Installing native messaging host for extension(s): ${EXTENSION_IDS[*]}"
echo ""

case "$(uname)" in
  Darwin)
    install_host "Google Chrome" \
      "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    install_host "Microsoft Edge" \
      "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
    install_host "Brave Browser" \
      "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    ;;
  Linux)
    install_host "Google Chrome" \
      "$HOME/.config/google-chrome/NativeMessagingHosts"
    install_host "Microsoft Edge" \
      "$HOME/.config/microsoft-edge/NativeMessagingHosts"
    install_host "Brave Browser" \
      "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    ;;
  *)
    echo "Error: Unsupported platform $(uname). This script supports macOS and Linux."
    echo "For Windows, manually create the registry entries and host manifest."
    exit 1
    ;;
esac

echo ""
echo "Done! Next steps:"
echo ""
echo "  1. Restart your browser (close all windows and reopen)"
echo "  2. Add the MCP server to your AI client(s):"
echo ""
echo "     Claude Code:  claude mcp add -s user agent-chrome-mcp -- $NODE_BIN $MCP_SERVER_PATH"
echo "     Codex:        codex mcp add agent-chrome-mcp -- $NODE_BIN $MCP_SERVER_PATH"
echo "     Antigravity:  Add to ~/.gemini/antigravity-cli/mcp_config.json or .agents/mcp.json:"
echo "                   {"
echo "                     \"mcpServers\": {"
echo "                       \"agent-chrome-mcp\": {"
echo "                         \"command\": \"node\","
echo "                         \"args\": [\"$MCP_SERVER_PATH\"]"
echo "                       }"
echo "                     }"
echo "                   }"
echo ""
echo "  3. Start a new client session and test:"
echo ""
echo '     Ask it: "Navigate to example.com and take a screenshot"'
echo ""
echo "  Multi-profile: enable the extension in each Chrome profile, then open the"
echo "  extension's Options page in each (chrome://extensions -> Details ->"
echo "  Extension options) and give it a label (e.g. work, personal). Either client can"
echo "  then target a profile via switch_browser / list_browsers or the 'profile' arg."
echo ""
