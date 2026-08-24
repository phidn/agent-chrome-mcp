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
- Navigation, DOM/accessibility inspection, screenshots, keyboard/mouse input, JavaScript execution, console and network capture, file upload, extension management, and screen recording.

## Architecture

```text
Claude Code, Codex, or Antigravity --stdio MCP--> host/mcp-server.js --loopback TCP--> host/native-host.js --native messaging--> Chrome extension --> your browser profile
```

The service uses `127.0.0.1:18766` and `~/.config/agent-chrome-mcp/config.json`, deliberately separate from `claude-chrome-mcp` so both projects can coexist.

## Install

Requirements: Node.js 18+, a Chromium browser, and Claude Code, Codex, or Antigravity.

1. Install host dependencies:

   ```bash
   cd /Volumes/Lexar_E6/davis/projects/agent-chrome-mcp/host
   npm install
   ```

2. In every browser profile you want agents to use, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this project's `extension/` directory. Copy the extension ID shown by Chrome.

3. Register the native messaging host. Supply every extension ID if you loaded the extension in several Chromium browsers:

   ```bash
   cd /Volumes/Lexar_E6/davis/projects/agent-chrome-mcp
   ./scripts/install.sh <extension-id> [additional-extension-id ...]
   ```

4. Fully quit and reopen the browser. Then add the same stdio server to your client:

   ```bash
   # Claude Code
   claude mcp add -s user agent-chrome-mcp -- "$(command -v node)" "/Volumes/Lexar_E6/davis/projects/agent-chrome-mcp/host/mcp-server.js"

   # Codex
   codex mcp add agent-chrome-mcp -- "$(command -v node)" "/Volumes/Lexar_E6/davis/projects/agent-chrome-mcp/host/mcp-server.js"
   ```

   For **Antigravity (CLI / IDE)**, add the server to `mcp_config.json` (e.g. `~/.gemini/antigravity-cli/mcp_config.json` or `.agents/mcp.json` in your workspace root, or via IDE: **Manage MCP Servers -> View raw config**):

   ```json
   {
     "mcpServers": {
       "agent-chrome-mcp": {
         "command": "node",
         "args": ["/Volumes/Lexar_E6/davis/projects/agent-chrome-mcp/host/mcp-server.js"]
       }
     }
   }
   ```

5. Start a new client session and ask it to call `tabs_context_mcp` with a unique `groupName`, then navigate to a page and take a screenshot.

## Profile routing

Open the extension's **Options** page in each Chrome profile and assign a label such as `work` or `personal`. A client can call:

```text
list_browsers()
switch_browser({ profile: "work" })
```

Any browser tool can also receive `profile: "work"` for a one-call override. If only one profile is connected, routing is automatic.

## Development

- Extension edit: reload it on `chrome://extensions`.
- Server edit: reconnect the MCP server in Claude Code, Codex, or Antigravity.
- Native host or install-script edit: re-run `scripts/install.sh` and restart all browser windows.
- `./scripts/chrome-mcp.sh` starts Chrome with `--silent-debugger-extension-api`, suppressing Chrome's debugging banner.

## Security

This extension can control tabs held in Agent Chrome MCP's named groups and it can access signed-in browser state for sites you direct it to. Load it only from this trusted local checkout, use unique tab-group names, and review agent instructions before they perform consequential browser actions.
