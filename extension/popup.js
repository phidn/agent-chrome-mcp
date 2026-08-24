// Popup: list the tools this extension exposes through MCP. The tool list is
// fetched live from the background service worker (Object.keys(toolHandlers)),
// so it never goes stale. Descriptions below are best-effort labels; a tool
// with no entry still shows up, just without a description.

const DESCRIPTIONS = {
  tabs_context_mcp: "List open tabs / current browser context.",
  tabs_create_mcp: "Open a new tab (optionally in a group).",
  close_tabs: "Close one or more tabs.",
  navigate: "Navigate a tab to a URL (back/forward/reload).",
  computer: "Screenshot, click, type, scroll, drag — pixel-level control.",
  read_page: "Read a structured, accessibility-style snapshot of the page.",
  get_page_text: "Extract the visible text content of the page.",
  find: "Find elements on the page by text or selector.",
  form_input: "Fill form fields (text, select, checkbox…).",
  javascript_tool: "Evaluate JavaScript in the page and return the result.",
  read_console_messages: "Read the page's console log output.",
  read_network_requests: "Inspect network requests made by the page.",
  resize_window: "Resize the browser window.",
  upload_image: "Upload an image into a file input on the page.",
  set_input_files: "Set files on an <input type=file> element.",
  insert_text: "Insert text at the focused input / editor.",
  gif_creator: "Capture a sequence of frames into a GIF.",
  record: "Record a tab / area / screen to a .webm video.",
  shortcuts_list: "List saved shortcuts / saved actions.",
  shortcuts_execute: "Run a saved shortcut / saved action.",
  switch_browser: "Switch the active browser profile by label.",
  list_browsers: "List connected browser profiles.",
  update_plan: "Update the in-progress plan overlay.",
  debug_extension: "Inspect this extension's targets / eval in its context.",
  manage_extensions: "List, enable, disable, uninstall, or reload/reconnect extensions.",
  healthcheck: "Report connection and runtime health.",
};

function setConn(connected, profileLabel, version) {
  const dot = document.getElementById("dot");
  const text = document.getElementById("connText");
  dot.className = "dot " + (connected ? "ok" : "bad");
  text.textContent = connected
    ? "Connected" + (profileLabel ? ` · ${profileLabel}` : "")
    : "Not connected to native host";
  if (version) document.getElementById("version").textContent = "v" + version;
}

let allTools = [];

function renderTools(filter) {
  const ul = document.getElementById("tools");
  const count = document.getElementById("count");
  const q = (filter || "").trim().toLowerCase();
  ul.innerHTML = "";

  if (!allTools.length) {
    ul.innerHTML = '<li class="empty">No tools available.</li>';
    count.textContent = "";
    return;
  }

  const matches = allTools.filter((name) => {
    if (!q) return true;
    const desc = (DESCRIPTIONS[name] || "").toLowerCase();
    return name.toLowerCase().includes(q) || desc.includes(q);
  });

  count.textContent = q
    ? `${matches.length} of ${allTools.length} tools`
    : `${allTools.length} tools available`;

  if (!matches.length) {
    ul.innerHTML = '<li class="empty">No tools match your search.</li>';
    return;
  }

  for (const name of matches) {
    const li = document.createElement("li");
    const tname = document.createElement("div");
    tname.className = "tname";
    const code = document.createElement("code");
    code.textContent = name;
    tname.appendChild(code);
    li.appendChild(tname);
    const desc = DESCRIPTIONS[name];
    if (desc) {
      const d = document.createElement("div");
      d.className = "tdesc";
      d.textContent = desc;
      li.appendChild(d);
    }
    ul.appendChild(li);
  }
}

const searchEl = document.getElementById("search");
searchEl.addEventListener("input", () => renderTools(searchEl.value));

chrome.runtime.sendMessage({ type: "get_tools" }, (res) => {
  if (chrome.runtime.lastError || !res) {
    setConn(false, null, null);
    allTools = [];
    renderTools("");
    return;
  }
  setConn(res.connected, res.profileLabel, res.version);
  allTools = res.tools || [];
  renderTools(searchEl.value);
});
