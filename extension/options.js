// Options page: read/write the per-profile label in chrome.storage.local.
// background.js watches storage.onChanged and re-sends host_hello to the MCP
// server when this value changes, so a rename takes effect without a restart.

const input = document.getElementById("label");
const saveBtn = document.getElementById("save");
const statusEl = document.getElementById("status");

async function load() {
  try {
    const { profileLabel } = await chrome.storage.local.get(["profileLabel"]);
    if (profileLabel) input.value = profileLabel;
  } catch {}
}

function setStatus(text) {
  statusEl.textContent = text;
  if (text) setTimeout(() => { statusEl.textContent = ""; }, 2500);
}

async function save() {
  // Accept one or more comma-separated labels (aliases). Trim, cap each at 60
  // chars, drop blanks/duplicates, and store the normalized "a, b" form.
  const labels = [...new Set(
    input.value.split(",").map((s) => s.trim().slice(0, 60)).filter(Boolean)
  )];
  if (!labels.length) {
    setStatus("Label cannot be empty.");
    return;
  }
  const value = labels.join(", ");
  saveBtn.disabled = true;
  try {
    await chrome.storage.local.set({ profileLabel: value });
    input.value = value; // reflect normalization back to the field
    setStatus(labels.length > 1 ? `Saved ${labels.length} labels.` : "Saved.");
  } catch (e) {
    setStatus("Error: " + e.message);
  } finally {
    saveBtn.disabled = false;
  }
}

saveBtn.addEventListener("click", save);
input.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
load();

// --- Connection status + manual reconnect ---
// The background service worker owns the native-host port; ask it for live
// status and let the user force a reconnect when a profile shows offline.
const dot = document.getElementById("dot");
const connText = document.getElementById("connText");
const connHint = document.getElementById("connHint");
const reconnectBtn = document.getElementById("reconnect");

function renderStatus(status) {
  if (!status) {
    dot.className = "dot pending";
    connText.textContent = "Status unavailable";
    connHint.textContent = "The extension's background worker did not respond. Reload the extension at chrome://extensions.";
    return;
  }
  if (status.connected) {
    dot.className = "dot ok";
    connText.textContent = "Connected to MCP";
    connHint.textContent = `Native bridge is running${status.version ? ` · extension v${status.version}` : ""}. Claude Code, Codex, and Antigravity can drive this profile.`;
  } else {
    dot.className = "dot bad";
    connText.textContent = "Disconnected";
    let hint = "No MCP client can reach this profile. Click Reconnect. If it stays red, the native messaging host may not be installed for this profile — re-run scripts/install.sh, then reload the extension.";
    if (status.lastDisconnectReason) hint += ` (last error: ${status.lastDisconnectReason})`;
    connHint.textContent = hint;
  }
}

function queryStatus() {
  try {
    chrome.runtime.sendMessage({ type: "get_connection_status" }, (resp) => {
      if (chrome.runtime.lastError) { renderStatus(null); return; }
      renderStatus(resp);
    });
  } catch {
    renderStatus(null);
  }
}

reconnectBtn.addEventListener("click", () => {
  reconnectBtn.disabled = true;
  dot.className = "dot pending";
  connText.textContent = "Reconnecting…";
  connHint.textContent = "";
  try {
    chrome.runtime.sendMessage({ type: "reconnect_native_host" }, (resp) => {
      reconnectBtn.disabled = false;
      if (chrome.runtime.lastError) { renderStatus(null); return; }
      renderStatus(resp);
      // Re-poll once more after the link settles to reflect the true state.
      setTimeout(queryStatus, 1200);
    });
  } catch {
    reconnectBtn.disabled = false;
    renderStatus(null);
  }
});

queryStatus();
setInterval(queryStatus, 1500);
