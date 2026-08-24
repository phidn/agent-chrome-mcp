<p align="center">
  <img src="assets/logo.png" alt="Agent Chrome MCP Logo" width="220" />
</p>

<h1 align="center">Agent Chrome MCP</h1>

<p align="center">
  <em>Use the same signed-in Chromium profile from <b>Claude Code</b>, <b>Codex</b>, and <b>Antigravity</b>.</em>
</p>

## What it provides

- Browser automation through the current Chrome, Brave, Edge, Arc, Opera, or Vivaldi profile.
- Per-profile labels (`work`, `personal`, …) and per-client routing via `list_browsers`, `switch_browser`, or a tool's optional `profile` argument.
- Named tab groups so concurrent agents have isolated browser tabs and windows.
- Navigation, DOM/accessibility inspection, screenshots, keyboard/mouse input, JavaScript execution, in-page authenticated relay fetching (`relay_fetch`), console and network capture, file upload, extension management, and screen recording.

## Architecture

```text
Claude Code, Codex, or Antigravity --stdio MCP--> host/mcp-server.js --loopback TCP--> host/native-host.js --native messaging--> Chrome extension --> your browser profile
```

The service uses `127.0.0.1:18766` and `~/.config/agent-chrome-mcp/config.json`, deliberately separate from `claude-chrome-mcp` so both projects can coexist.

## Quick Install

Requirements: Node.js 18+, a Chromium browser, and Claude Code, Codex, or Antigravity.

1. **Clone repository and install dependencies**:

   ```bash
   git clone https://github.com/phidn/agent-chrome-mcp.git
   cd agent-chrome-mcp/host
   npm install
   cd ..
   ```

2. **Load the extension**:
   - In every browser profile you want agents to use, navigate to `chrome://extensions` (or `brave://extensions`, `edge://extensions`).
   - Enable **Developer mode**.
   - Click **Load unpacked** and select the repository's `extension/` directory.
   - Copy the Extension ID shown under the extension name.

3. **Register the native messaging host**:
   Supply every extension ID if you loaded the extension in several Chromium browsers/profiles:

   ```bash
   ./scripts/install.sh <extension-id> [additional-extension-id ...]
   # Or using make:
   make install IDS="<extension-id> [additional-extension-id ...]"
   ```

4. **Restart your browser**:
   Fully quit and reopen the browser.

5. **Configure your AI client**:

   ```bash
   # Claude Code
   claude mcp add -s user agent-chrome-mcp -- "$(command -v node)" "$(pwd)/host/mcp-server.js"

   # Codex
   codex mcp add agent-chrome-mcp -- "$(command -v node)" "$(pwd)/host/mcp-server.js"
   ```

   For **Antigravity (CLI / IDE)**, add the server to `mcp_config.json` (e.g. `~/.gemini/antigravity-cli/mcp_config.json` or `.agents/mcp.json` in your workspace root):

   ```json
   {
     "mcpServers": {
       "agent-chrome-mcp": {
         "command": "node",
         "args": ["/path/to/agent-chrome-mcp/host/mcp-server.js"]
       }
     }
   }
   ```

6. Start a new client session and ask it to call `tabs_context_mcp` with a unique `groupName`, then navigate to a page and take a screenshot.

## Profile Routing

Open the extension's **Options** page in each Chrome profile and assign a label such as `work` or `personal`. A client can call:

```text
list_browsers()
switch_browser({ profile: "work" })
```

Any browser tool can also receive `profile: "work"` for a one-call override. If only one profile is connected, routing is automatic.

## Development & Helper Commands

You can run `make menu` or individual targets:

- `make install IDS="<extension-id> ..."`: Register native messaging host.
- `make uninstall`: Remove native messaging host manifests and wrapper script.
- `make chrome`: Launch Chrome with `--silent-debugger-extension-api` (suppresses Chrome's debugging banner).
- `make chrome-app`: Create `/Applications/Chrome MCP.app` launcher on macOS.
- `make chrome-remove`: Remove `/Applications/Chrome MCP.app`.

## Security

This extension can control tabs held in Agent Chrome MCP's named groups and it can access signed-in browser state for sites you direct it to. Load it only from this trusted local checkout, use unique tab-group names, and review agent instructions before they perform consequential browser actions.
