#!/usr/bin/env node

// MCP Server for Agent Chrome MCP extension.
// Started by any compatible MCP client via stdio transport.
//
// Operates in one of two modes:
// - PRIMARY: Owns the TCP port, accepts native host + client connections
// - CLIENT: Port already taken by another session, connects as a client
//
// This allows multiple MCP client sessions to share one browser extension.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";


const DEFAULT_PORT = 18766;

function getPort() {
  const configPath = path.join(os.homedir(), ".config", "agent-chrome-mcp", "config.json");
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return config.port || DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

const TCP_PORT = getPort();

// --- Mode detection ---
// Try to bind the port. If it's taken, switch to client mode.
let mode = "primary"; // or "client"

// --- Shared state ---
// Multiple Chrome profiles can each connect their own native host. We key them
// by a self-reported label (sent via host_hello) so tool calls can be routed to
// a specific profile. Single-profile users never set a label — the sole host is
// auto-selected, so behavior is unchanged.
const nativeHosts = new Map(); // label -> { socket, version, connectedAt, lastMessageAt }
const pendingRequests = new Map(); // id -> { resolve, reject, timer, tool, args, targetLabel, resent }
let requestIdCounter = 0;

// Per-session active profile (the routing target chosen via switch_browser).
// localTarget is for this server's own MCP session (primary mode); clientTargets
// holds the target for each connected client mcp-server, keyed by clientId. Kept
// per-session so concurrent MCP client sessions sharing one primary don't stomp
// each other's selection.
let localTarget = null;
const clientTargets = new Map(); // clientId -> label

// Connection state tracking for diagnostics + smarter error messages.
// nativeHostEverConnected: has a native host EVER connected to this primary
//   since startup? Distinguishes "extension never installed" from "extension
//   was here and is currently dropped".
// lastNativeHostConnectAt: timestamp of the most recent successful connection
// lastNativeHostDisconnectAt: timestamp of the most recent disconnection
// lastNativeHostMessageAt: timestamp of the most recent inbound message
const serverStartedAt = Date.now();
let nativeHostEverConnected = false;
let lastNativeHostConnectAt = null;
let lastNativeHostDisconnectAt = null;
let lastNativeHostMessageAt = null;

// Primary mode: track client MCP server connections
const clientSockets = new Map(); // clientId -> socket
let clientIdCounter = 0;
// Map from prefixed request ID -> { clientId, originalId }
const clientRequestMap = new Map();

// Client mode: TCP connection to the primary
let primarySocket = null;
let clientBuffer = Buffer.alloc(0);

// --- Diagnostic helpers ---

function fmtAgo(ts) {
  if (!ts) return "never";
  const ms = Date.now() - ts;
  if (ms < 1000) return `${ms}ms ago`;
  if (ms < 60000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  return `${Math.floor(ms / 3600000)}h ago`;
}

function describeExtensionUnavailable() {
  if (mode === "client") {
    return "Lost connection to the primary MCP server (multi-session multiplexing). The primary may have been killed. Restart the configured MCP server, then reconnect your client.";
  }
  if (!nativeHostEverConnected) {
    return [
      "Browser extension has NEVER connected to this MCP server since it started",
      `${fmtAgo(serverStartedAt)}.`,
      "",
      "Likely causes:",
      "  1. Chrome / Brave / Edge is not currently running. Open it.",
      "  2. The Agent Chrome MCP extension is not loaded or is disabled.",
      "     Check chrome://extensions and ensure it's enabled.",
      "  3. scripts/install.sh was never run for this browser, or the extension ID",
      "     in the native messaging manifest doesn't match the loaded extension.",
      "     Re-run: ./scripts/install.sh <extension-id> from the project root,",
      "     then restart the browser.",
      "  4. The browser was just opened — the service worker may not have",
      "     started yet. Open any tab to wake it, then retry.",
      "",
      "Call the healthcheck tool for full diagnostics.",
    ].join("\n");
  }
  return [
    `Browser extension was connected but the native messaging host is currently disconnected (last seen ${fmtAgo(lastNativeHostDisconnectAt)}, last message ${fmtAgo(lastNativeHostMessageAt)}).`,
    "",
    "Likely causes:",
    "  1. Chrome service worker was evicted. Open any tab in the browser",
    "     to wake it back up — the keep-alive alarm will reconnect it.",
    "  2. Browser was closed. Reopen it and the extension will reconnect.",
    "  3. Service worker crashed. Reload the extension at chrome://extensions.",
    "",
    "Call the healthcheck tool for full diagnostics.",
  ].join("\n");
}

// --- Native host (profile) registry & routing ---

// Normalize a host_hello label payload (string or array) into a deduped,
// non-empty list of trimmed labels.
function normalizeLabels(raw) {
  let list = Array.isArray(raw) ? raw : [raw];
  list = list
    .map((l) => (typeof l === "string" ? l.trim().slice(0, 60) : ""))
    .filter(Boolean);
  list = [...new Set(list)];
  return list.length ? list : ["default"];
}

// Find the registry entry whose primary key OR any alias matches `label`.
// Returns { key, entry } (key is the primary/map key) or null.
function findHost(label) {
  if (nativeHosts.has(label)) return { key: label, entry: nativeHosts.get(label) };
  for (const [key, entry] of nativeHosts) {
    if (entry.labels && entry.labels.includes(label)) return { key, entry };
  }
  return null;
}

// Every label currently advertised by any connected profile (primary + aliases).
function allLabels() {
  const out = [];
  for (const [key, entry] of nativeHosts) {
    for (const l of entry.labels || [key]) out.push(l);
  }
  return out;
}

// Register (or relabel/reconnect) a native host socket under one or more profile
// labels (aliases). A profile occupies a single registry entry (keyed by its
// primary label) and is reachable via any of its labels. Colliding labels from
// different live sockets are de-duplicated with a #N suffix.
function registerHost(socket, rawLabels, version) {
  const requested = normalizeLabels(rawLabels);

  // If this socket was already registered (live relabel via a new host_hello,
  // or a periodic re-announce), drop its old entry first so its labels are free
  // to re-claim — but remember connectedAt/version to carry forward.
  let prev = null;
  for (const [key, entry] of nativeHosts) {
    if (entry.socket === socket) { prev = entry; nativeHosts.delete(key); break; }
  }

  // Labels held by *other* live sockets must not be clobbered.
  const taken = new Set();
  for (const [key, entry] of nativeHosts) {
    if (entry.socket === socket) continue;
    for (const l of entry.labels || [key]) taken.add(l);
  }
  const labels = requested.map((base) => {
    let label = base, n = 2;
    while (taken.has(label)) label = `${base}#${n++}`;
    taken.add(label);
    return label;
  });

  const primary = labels[0];
  nativeHosts.set(primary, {
    socket,
    version: version || prev?.version || null,
    connectedAt: prev?.connectedAt || Date.now(),
    lastMessageAt: Date.now(),
    labels,
  });
  socket._chromeLabel = primary;
  const shown = labels.length > 1 ? `"${labels.join('", "')}"` : `"${primary}"`;
  process.stderr.write(`Native host registered: ${shown}${version ? " v" + version : ""} (${nativeHosts.size} profile(s) connected)\n`);
}

// Resolve which profile label a request should target, given the caller.
// requesterId is "local" (this server's own session) or a clientId string.
function resolveTarget(args, requesterId) {
  if (args && typeof args.profile === "string" && args.profile.trim()) {
    const p = args.profile.trim();
    if (findHost(p) || nativeHosts.size !== 1) return p;
    return [...nativeHosts.keys()][0];
  }
  const explicit = requesterId === "local" ? localTarget : clientTargets.get(requesterId);
  if (explicit) return explicit;
  if (nativeHosts.size === 1) return [...nativeHosts.keys()][0];
  return null; // ambiguous: caller must choose
}

// Resolve to a live host socket or throw a descriptive error.
function pickHost(args, requesterId) {
  if (nativeHosts.size === 0) throw new Error(describeExtensionUnavailable());
  const requested = resolveTarget(args, requesterId);
  if (requested == null) {
    throw new Error(
      `Multiple browser profiles are connected (${allLabels().join(", ")}). ` +
      `Specify which one with the "profile" argument, or call switch_browser({ profile }) first.`
    );
  }
  const found = findHost(requested);
  if (!found || found.entry.socket.destroyed) {
    const names = allLabels();
    throw new Error(`Browser profile "${requested}" is not connected. Available: ${names.length ? names.join(", ") : "(none)"}.`);
  }
  // Route under the primary key so in-flight tracking/cleanup stays consistent.
  return { label: found.key, socket: found.entry.socket };
}

// Snapshot of connected profiles + the caller's effective active target.
function browsersInfo(requesterId) {
  const current = requesterId === "local" ? localTarget : clientTargets.get(requesterId);
  const effective = current || (nativeHosts.size === 1 ? [...nativeHosts.keys()][0] : null);
  return {
    profiles: [...nativeHosts.entries()].map(([label, e]) => ({
      label,
      // All aliases this profile answers to (omitted when there's just the one).
      aliases: (e.labels && e.labels.length > 1) ? e.labels : undefined,
      version: e.version || null,
      connectedAt: new Date(e.connectedAt).toISOString(),
      lastMessageAgo: fmtAgo(e.lastMessageAt),
      active: label === effective,
    })),
    activeProfile: effective,
    explicitlySelected: !!current,
  };
}

// Set the caller's active profile target. Accepts any alias; throws if not
// connected. Stores the resolved primary key so it survives alias lookups.
function setTarget(requesterId, rawLabel) {
  const label = typeof rawLabel === "string" ? rawLabel.trim() : "";
  if (!label) throw new Error('switch_browser requires a "profile" argument. Call list_browsers to see connected profiles.');
  const found = findHost(label);
  if (!found) {
    const names = allLabels();
    throw new Error(`No connected browser profile named "${label}". Available: ${names.length ? names.join(", ") : "(none)"}.`);
  }
  if (requesterId === "local") localTarget = found.key;
  else clientTargets.set(requesterId, found.key);
  return found.key;
}

// --- sendToExtension: works in both modes ---

function sendToExtension(tool, args, requesterId = "local") {
  return new Promise((resolve, reject) => {
    const id = String(++requestIdCounter);
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(
        `Tool request "${tool}" timed out after 60s.\n\n` +
        "The native host accepted the request but the extension never replied.\n" +
        "The service worker may be hung; try reloading the extension at chrome://extensions.\n" +
        "Call the healthcheck tool for full diagnostics."
      ));
    }, 60000);

    if (mode === "primary") {
      let host;
      try {
        host = pickHost(args, requesterId);
      } catch (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      // The extension doesn't understand the routing-only `profile` arg; strip it.
      const sendArgs = { ...(args || {}) };
      delete sendArgs.profile;
      pendingRequests.set(id, { resolve, reject, timer, tool, args: sendArgs, targetLabel: host.label, resent: false });
      host.socket.write(JSON.stringify({ id, type: "tool_request", tool, args: sendArgs }) + "\n");
    } else {
      // Client mode: forward to primary (keep `profile` so the primary can route).
      if (!primarySocket || primarySocket.destroyed) {
        clearTimeout(timer);
        reject(new Error(describeExtensionUnavailable()));
        return;
      }
      pendingRequests.set(id, { resolve, reject, timer, tool, args, resent: false });
      primarySocket.write(JSON.stringify({ id, type: "tool_request", tool, args }) + "\n");
    }
  });
}

// --- Pidfile management ---

const pidfilePath = path.join(os.tmpdir(), `agent-chrome-mcp-mcp-${TCP_PORT}.pid`);

function writePidfile() {
  try { fs.writeFileSync(pidfilePath, String(process.pid)); } catch {}
}

function cleanupPidfile() {
  try {
    const content = fs.readFileSync(pidfilePath, "utf-8").trim();
    if (content === String(process.pid)) fs.unlinkSync(pidfilePath);
  } catch {}
}

function shutdown() {
  if (mode === "primary") cleanupPidfile();
  for (const [, { socket }] of nativeHosts) {
    if (socket && !socket.destroyed) socket.destroy();
  }
  if (primarySocket && !primarySocket.destroyed) primarySocket.destroy();
  for (const [, sock] of clientSockets) {
    if (!sock.destroyed) sock.destroy();
  }
  for (const [, { reject, timer }] of pendingRequests) {
    clearTimeout(timer);
    reject(new Error("Server shutting down"));
  }
  pendingRequests.clear();
  if (mode === "primary") tcpServer.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGHUP", shutdown);
process.stdin.on("end", shutdown);
process.stdin.resume();

// --- Primary mode: handle incoming TCP connections ---

function handleResponse(msg) {
  // Check if this response is for a client request (prefixed ID)
  if (msg.id && clientRequestMap.has(msg.id)) {
    const { clientId, originalId } = clientRequestMap.get(msg.id);
    clientRequestMap.delete(msg.id);
    const clientSocket = clientSockets.get(clientId);
    if (clientSocket && !clientSocket.destroyed) {
      const fwd = JSON.stringify({ ...msg, id: originalId }) + "\n";
      clientSocket.write(fwd);
    }
    return;
  }

  // Otherwise it's for a local request
  if (msg.id && pendingRequests.has(msg.id)) {
    const { resolve, reject, timer } = pendingRequests.get(msg.id);
    clearTimeout(timer);
    pendingRequests.delete(msg.id);
    if (msg.type === "tool_error") {
      reject(new Error(msg.error || "Tool execution failed"));
    } else {
      resolve(msg.result);
    }
  }
}

function processLine(line) {
  if (!line) return;
  try {
    const msg = JSON.parse(line);
    if (msg.type === "heartbeat") return;
    handleResponse(msg);
  } catch {}
}

const tcpServer = net.createServer((socket) => {
  // Classification: wait briefly for a client_hello. If none arrives, treat as native host.
  // Native hosts (launched by the browser) don't send data immediately on connect.
  // Client MCP servers send client_hello immediately.
  let classified = false;
  let earlyBuffer = Buffer.alloc(0);

  const classifyTimeout = setTimeout(() => {
    if (!classified) {
      classified = true;
      setupNativeHostConnection(socket, earlyBuffer);
    }
  }, 500); // 500ms is plenty for a local client_hello

  socket.on("data", function onEarlyData(chunk) {
    if (classified) return; // Already classified, data handler was replaced
    earlyBuffer = Buffer.concat([earlyBuffer, chunk]);
    const newlineIdx = earlyBuffer.indexOf(10);
    if (newlineIdx === -1) return; // No full line yet, keep buffering

    const firstLine = earlyBuffer.subarray(0, newlineIdx).toString("utf-8").trim();
    try {
      const firstMsg = JSON.parse(firstLine);
      if (firstMsg.type === "client_hello") {
        classified = true;
        clearTimeout(classifyTimeout);
        socket.removeListener("data", onEarlyData);
        setupClientConnection(socket, earlyBuffer.subarray(newlineIdx + 1));
        return;
      }
    } catch {}

    // Got data but it's not a client_hello, this is a native host
    classified = true;
    clearTimeout(classifyTimeout);
    socket.removeListener("data", onEarlyData);
    setupNativeHostConnection(socket, earlyBuffer);
  });
});

function setupNativeHostConnection(socket, initialBuffer) {
  // Multiple profiles are allowed: each native host registers under its own
  // label (sent via host_hello). The host is provisionally unlabeled until then.
  nativeHostEverConnected = true;
  lastNativeHostConnectAt = Date.now();
  lastNativeHostMessageAt = Date.now();
  socket._chromeLabel = null;

  let buffer = initialBuffer;

  // Old extensions never send host_hello (they only reply to tool requests).
  // After a short grace period, give such a host the "default" label so it
  // still works without any configuration.
  const labelTimer = setTimeout(() => {
    if (!socket.destroyed && socket._chromeLabel === null) registerHost(socket, "default");
  }, 1500);

  function handleHostLine(line) {
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === "host_hello") {
      // `labels` (array) is the multi-alias form; fall back to `label` for
      // older extensions that only send a single string.
      registerHost(socket, msg.labels || msg.label, msg.version);
      return;
    }
    if (msg.type === "heartbeat") return;
    handleResponse(msg);
  }

  // Process any data already in the buffer
  let idx;
  while ((idx = buffer.indexOf(10)) !== -1) {
    handleHostLine(buffer.subarray(0, idx).toString("utf-8").trim());
    buffer = buffer.subarray(idx + 1);
  }

  socket.on("data", (chunk) => {
    lastNativeHostMessageAt = Date.now();
    const entry = socket._chromeLabel && nativeHosts.get(socket._chromeLabel);
    if (entry && entry.socket === socket) entry.lastMessageAt = Date.now();
    buffer = Buffer.concat([buffer, chunk]);
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf(10)) !== -1) {
      handleHostLine(buffer.subarray(0, newlineIdx).toString("utf-8").trim());
      buffer = buffer.subarray(newlineIdx + 1);
    }
  });

  function cleanup() {
    clearTimeout(labelTimer);
    lastNativeHostDisconnectAt = Date.now();
    const label = socket._chromeLabel;
    // Only remove the registry entry if it still points at THIS socket — a
    // reconnect may have already replaced it under the same label.
    if (label && nativeHosts.get(label)?.socket === socket) nativeHosts.delete(label);

    // Resend in-flight requests that targeted this host. If a replacement host
    // with the same label has reconnected, route to it; otherwise fail them.
    if (pendingRequests.size > 0) {
      setTimeout(() => {
        for (const [id, entry] of pendingRequests) {
          if (entry.targetLabel !== label || entry.resent) continue;
          const repl = nativeHosts.get(label);
          if (repl && !repl.socket.destroyed) {
            entry.resent = true;
            repl.socket.write(JSON.stringify({ id, type: "tool_request", tool: entry.tool, args: entry.args }) + "\n");
          } else {
            clearTimeout(entry.timer);
            entry.reject(new Error("Native host disconnected"));
            pendingRequests.delete(id);
          }
        }
      }, 5000);
    }
  }

  socket.on("error", cleanup);
  socket.on("close", cleanup);
}

function setupClientConnection(socket, initialBuffer) {
  const clientId = String(++clientIdCounter);
  clientSockets.set(clientId, socket);
  process.stderr.write(`Client MCP server connected (client ${clientId})\n`);

  // Send ack
  socket.write(JSON.stringify({ type: "client_ack", clientId }) + "\n");

  let buffer = initialBuffer;

  function processClientData() {
    let idx;
    while ((idx = buffer.indexOf(10)) !== -1) {
      const line = buffer.subarray(0, idx).toString("utf-8").trim();
      buffer = buffer.subarray(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === "tool_request" && msg.id) {
          // Profile-management tools are answered by the primary itself — they
          // never reach the extension. They set/inspect this client's routing.
          if (msg.tool === "list_browsers" || msg.tool === "switch_browser") {
            try {
              let envelope;
              if (msg.tool === "list_browsers") {
                envelope = textResult(JSON.stringify(browsersInfo(clientId), null, 2));
              } else {
                const label = setTarget(clientId, msg.args && msg.args.profile);
                envelope = textResult(`Switched to browser profile "${label}".\n\n` + JSON.stringify(browsersInfo(clientId), null, 2));
              }
              socket.write(JSON.stringify({ id: msg.id, type: "tool_response", result: envelope }) + "\n");
            } catch (e) {
              socket.write(JSON.stringify({ id: msg.id, type: "tool_error", error: e.message }) + "\n");
            }
          } else {
            // Forward to the targeted native host with a prefixed ID.
            let host = null;
            try {
              host = pickHost(msg.args, clientId);
            } catch (e) {
              socket.write(JSON.stringify({ id: msg.id, type: "tool_error", error: e.message }) + "\n");
            }
            if (host) {
              const prefixedId = `c${clientId}_${msg.id}`;
              clientRequestMap.set(prefixedId, { clientId, originalId: msg.id });
              const sendArgs = { ...(msg.args || {}) };
              delete sendArgs.profile;
              host.socket.write(JSON.stringify({ id: prefixedId, type: "tool_request", tool: msg.tool, args: sendArgs }) + "\n");
            }
          }
        }
      } catch {}
    }
  }

  // Process initial buffer
  processClientData();

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    processClientData();
  });

  socket.on("error", () => {});
  socket.on("close", () => {
    clientSockets.delete(clientId);
    // Clean up any pending client requests
    for (const [prefixedId, info] of clientRequestMap) {
      if (info.clientId === clientId) clientRequestMap.delete(prefixedId);
    }
    process.stderr.write(`Client MCP server disconnected (client ${clientId})\n`);
  });
}

// --- Client mode: connect to primary ---

// After this many consecutive failed reconnects to the primary, try to bind
// the port ourselves and promote to primary. This fixes the "primary died,
// clients retry forever" availability bug — the port is free, so we should
// take it over instead of waiting for nothing.
const PROMOTE_AFTER_FAILED_RECONNECTS = 3;
let clientReconnectAttempts = 0;

async function tryPromoteToPrimary() {
  return new Promise((resolve) => {
    const onError = (err) => {
      tcpServer.removeListener("listening", onListen);
      if (err.code === "EADDRINUSE") {
        // Another mcp-server beat us to the port. Stay as client, keep retrying.
        process.stderr.write(`Port ${TCP_PORT} taken by another primary. Remaining as client.\n`);
      } else {
        process.stderr.write(`Failed to promote to primary: ${err.message}\n`);
      }
      resolve(false);
    };
    const onListen = () => {
      tcpServer.removeListener("error", onError);
      mode = "primary";
      writePidfile();
      process.stderr.write(`Promoted from client to primary on :${TCP_PORT}. Native host and future clients will now connect here.\n`);
      resolve(true);
    };
    tcpServer.once("error", onError);
    tcpServer.once("listening", onListen);
    try {
      tcpServer.listen(TCP_PORT, "127.0.0.1");
    } catch (e) {
      tcpServer.removeListener("error", onError);
      tcpServer.removeListener("listening", onListen);
      process.stderr.write(`Listen threw during promotion: ${e.message}\n`);
      resolve(false);
    }
  });
}

function startClientMode() {
  mode = "client";
  process.stderr.write(`Port ${TCP_PORT} in use. Connecting as client to primary MCP server...\n`);

  function connect() {
    let handshakeComplete = false;

    primarySocket = net.createConnection(TCP_PORT, "127.0.0.1", () => {
      handshakeComplete = true;
      clientReconnectAttempts = 0;
      process.stderr.write(`Connected to primary MCP server on :${TCP_PORT}\n`);
      // Send handshake
      primarySocket.write(JSON.stringify({ type: "client_hello" }) + "\n");
    });

    primarySocket.on("data", (chunk) => {
      clientBuffer = Buffer.concat([clientBuffer, chunk]);
      let idx;
      while ((idx = clientBuffer.indexOf(10)) !== -1) {
        const line = clientBuffer.subarray(0, idx).toString("utf-8").trim();
        clientBuffer = clientBuffer.subarray(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === "client_ack") continue;
          if (msg.type === "error") {
            process.stderr.write(`Primary server error: ${msg.error}\n`);
            continue;
          }
          // Tool response routed back from primary
          if (msg.id && pendingRequests.has(msg.id)) {
            const { resolve, reject, timer } = pendingRequests.get(msg.id);
            clearTimeout(timer);
            pendingRequests.delete(msg.id);
            if (msg.type === "tool_error") {
              reject(new Error(msg.error || "Tool execution failed"));
            } else {
              resolve(msg.result);
            }
          }
        } catch {}
      }
    });

    primarySocket.on("error", (err) => {
      process.stderr.write(`Client connection error: ${err.message}\n`);
    });

    primarySocket.on("close", async () => {
      primarySocket = null;
      // Primary died, reject pending requests
      for (const [, { reject, timer }] of pendingRequests) {
        clearTimeout(timer);
        reject(new Error("Primary MCP server disconnected"));
      }
      pendingRequests.clear();

      // Only count failed reconnect attempts — if we did handshake and then
      // got dropped, that's a normal primary cycle, not a dead primary.
      if (!handshakeComplete) {
        clientReconnectAttempts++;
      }

      // After N failed attempts, try to become primary ourselves. The port
      // is likely free (primary is gone). If another process beat us to it,
      // EADDRINUSE throws and we stay client.
      if (clientReconnectAttempts >= PROMOTE_AFTER_FAILED_RECONNECTS) {
        const promoted = await tryPromoteToPrimary();
        if (promoted) {
          clientReconnectAttempts = 0;
          return; // Stop the reconnect loop — we're primary now
        }
        clientReconnectAttempts = 0; // Reset so we don't promote every time
      }

      setTimeout(connect, 2000);
    });
  }

  connect();
}

// --- Startup: try primary, fall back to client ---

async function start() {
  // Clean up stale pidfiles (but don't kill live servers)
  const pidfiles = [
    pidfilePath,
    path.join(os.tmpdir(), `unblocked-chrome-mcp-${TCP_PORT}.pid`),
  ];
  for (const pf of pidfiles) {
    try {
      const oldPid = parseInt(fs.readFileSync(pf, "utf-8").trim(), 10);
      if (oldPid && oldPid !== process.pid) {
        try {
          process.kill(oldPid, 0); // Check if alive
          // It's alive. DON'T kill it. We'll run as client instead.
        } catch {
          // Dead process, clean up pidfile
          try { fs.unlinkSync(pf); } catch {}
        }
      }
    } catch {}
  }

  // Try to bind the port
  return new Promise((resolve) => {
    tcpServer.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        // Port taken by another live session. Run as client.
        startClientMode();
        resolve();
      } else {
        process.stderr.write(`TCP server error: ${err.message}\n`);
        process.exit(1);
      }
    });

    tcpServer.listen(TCP_PORT, "127.0.0.1", () => {
      mode = "primary";
      writePidfile();
      process.stderr.write(`Primary MCP server listening on :${TCP_PORT}\n`);
      resolve();
    });
  });
}

await start();

// --- Helper to wrap tool results for MCP ---

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function imageResult(base64, mimeType = "image/png") {
  return { content: [{ type: "image", data: base64, mimeType }] };
}

function mixedResult(parts) {
  return { content: parts };
}

// --- Per-call action summary -------------------------------------------------
// Build a short, deterministic one-line label of WHAT a tool call is doing, so
// the user can tell at a glance what Agent Chrome MCP is up to. This is pure
// string-building — no LLM call, no extra tokens. The line is prepended to every
// tool result, so it surfaces in the collapsed result preview.

function truncate(s, n) {
  s = String(s).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function summarizeCall(toolName, args = {}) {
  const a = args || {};
  let d = "";
  switch (toolName) {
    case "navigate":
      d = a.url ? `→ ${a.url}` : "";
      break;
    case "computer": {
      const p = a.action ? [a.action] : [];
      if (a.coordinate) p.push(`@(${a.coordinate.join(",")})`);
      else if (a.start_coordinate) p.push(`@(${a.start_coordinate.join(",")})`);
      else if (a.ref) p.push(`@${a.ref}`);
      if (a.action === "type" && a.text != null) p.push(`"${truncate(a.text, 40)}"`);
      else if (a.action === "key" && a.text != null) p.push(`[${truncate(a.text, 30)}]`);
      else if (a.action === "scroll" && a.scroll_direction) p.push(a.scroll_direction);
      else if (a.action === "wait" && a.duration != null) p.push(`${a.duration}s`);
      d = p.join(" ");
      break;
    }
    case "find":
      d = a.query ? `"${truncate(a.query, 50)}"` : "";
      break;
    case "form_input":
      d = a.ref ? `${a.ref}=${truncate(a.value, 30)}` : "";
      break;
    case "insert_text":
      d = a.text != null ? `"${truncate(a.text, 40)}"` : "";
      break;
    case "javascript_tool":
      d = a.text ? truncate(a.text, 50) : "";
      break;
    case "read_console_messages":
      d = a.pattern ? `/${truncate(a.pattern, 30)}/` : "";
      break;
    case "read_network_requests":
      d = a.urlPattern ? `/${truncate(a.urlPattern, 30)}/` : "";
      break;
    case "read_page":
      d = a.ref_id ? `@${a.ref_id}` : (a.filter || "");
      break;
    case "resize_window":
      d = a.width && a.height ? `${a.width}×${a.height}` : "";
      break;
    case "tabs_context_mcp":
      d = a.groupName ? a.groupName + (a.createIfEmpty ? " (create)" : "") : "(list all)";
      break;
    case "tabs_create_mcp":
      d = a.groupName || "";
      break;
    case "close_tabs":
      d = a.groupName ? a.groupName : (Array.isArray(a.tabIds) ? `[${a.tabIds.join(",")}]` : "");
      break;
    case "set_input_files":
      d = Array.isArray(a.files) ? truncate(a.files.join(", "), 50) : "";
      break;
    case "upload_image":
      d = a.imageId ? truncate(a.imageId, 30) : "";
      break;
    case "shortcuts_execute":
      d = a.command || a.shortcutId || "";
      break;
    case "switch_browser":
      d = a.profile || "";
      break;
    case "gif_creator":
    case "manage_extensions":
    case "debug_extension":
      d = [a.action, a.extensionId || a.id || a.targetId].filter(Boolean).join(" ");
      break;
    case "record":
      d = [a.action, a.source].filter(Boolean).join(" ");
      break;
  }
  const tab = a.tabId != null ? ` · tab ${a.tabId}` : "";
  // Only show the profile when explicitly routed per-call (multi-profile setups).
  const prof = a.profile ? ` · ${a.profile}` : "";
  return `▸ ${toolName}${d ? " " + d : ""}${tab}${prof}`;
}

// Prepend the action summary as the leading content of a tool result, keeping
// any image parts (e.g. screenshots) intact.
function withSummary(summary, result) {
  if (typeof result === "string") return textResult(`${summary}\n${result}`);
  if (result && Array.isArray(result.content)) {
    return { ...result, content: [{ type: "text", text: summary }, ...result.content] };
  }
  return textResult(`${summary}\n${JSON.stringify(result, null, 2)}`);
}

async function callTool(toolName, args) {
  const summary = summarizeCall(toolName, args);
  try {
    const result = await sendToExtension(toolName, args);
    return withSummary(summary, result);
  } catch (err) {
    return textResult(`${summary}\n✗ Error: ${err.message}`);
  }
}

// --- MCP Server with all tools ---

const server = new McpServer({
  name: "agent-chrome-mcp",
  version: "1.0.0",
});

// Pre-validation arg coercion
{
  const origSetRequestHandler = server.server.setRequestHandler.bind(server.server);
  server.server.setRequestHandler = function(schema, handler) {
    return origSetRequestHandler(schema, async (request, extra) => {
      const args = request?.params?.arguments;
      if (args) {
        if (typeof args.tabId === "string") args.tabId = Number(args.tabId);
        if (typeof args.coordinate === "string") {
          try { args.coordinate = JSON.parse(args.coordinate); } catch {}
        }
        if (typeof args.start_coordinate === "string") {
          try { args.start_coordinate = JSON.parse(args.start_coordinate); } catch {}
        }
        if (typeof args.region === "string") {
          try { args.region = JSON.parse(args.region); } catch {}
        }
      }
      return handler(request, extra);
    });
  };
}
// Optional per-call routing override shared by every browser tool. When more
// than one Chrome profile is connected, pass this to target a specific one;
// otherwise the session's active profile (or the sole connected one) is used.
const profileArg = z.string().optional().describe("Target Chrome profile label (from list_browsers). Omit to use this session's active profile, or the only connected one when there's just one.");

// 1. tabs_context_mcp
server.tool(
  "tabs_context_mcp",
  "Establish or inspect a NAMED tab group owned by your agent. CRITICAL: Call this at the start of every session with a unique, project-meaningful groupName (e.g. 'agent-foo', 'sergen-claude', 'research-bot') and createIfEmpty: true to bootstrap your isolated working group. Multiple agents/repos can share the same browser by each picking a distinct groupName — the group name is the per-tab metadata that distinguishes which agent owns which tab in the Chrome tab strip. Without a groupName argument, this returns ALL groups currently managed by this extension (useful for orchestrators that need to see the full topology).",
  {
    groupName: z.string().optional().describe("The unique name for your agent's tab group. Required when establishing a new group; omit to list all existing groups. Max 50 characters."),
    createIfEmpty: z.boolean().optional().describe("If true and the named group does not yet exist, create it (opens a new browser window with one empty tab labelled with groupName). Ignored when groupName is omitted."),
    color: z.enum(["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]).optional().describe("Optional color for the group when creating it. Defaults to blue. Picking a distinct color per agent makes them easy to tell apart visually in the tab strip."),
    profile: profileArg,
  },
  async (args) => callTool("tabs_context_mcp", args)
);

// 2. tabs_create_mcp
server.tool(
  "tabs_create_mcp",
  "Create a new empty tab inside your NAMED tab group. groupName is REQUIRED — pass the same name you used in tabs_context_mcp to bootstrap the group. The new tab is added to that named group only; tabs in other agents' groups are not touched. If the named group does not yet exist this call will create it (idempotent), but the canonical entry point for establishing a group is tabs_context_mcp({ groupName, createIfEmpty: true }).",
  {
    groupName: z.string().describe("The name of YOUR agent's tab group. Required. Must match the groupName you established with tabs_context_mcp."),
    color: z.enum(["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]).optional().describe("Optional color, only honored if this call ends up creating the group. Defaults to blue."),
    profile: profileArg,
  },
  async (args) => callTool("tabs_create_mcp", args)
);

// 3. close_tabs
server.tool(
  "close_tabs",
  "Close tabs that this extension manages. Call at session end to tear down your agent's workspace cleanly. Provide EXACTLY ONE of:\n- `groupName`: closes ALL tabs in that named group. Since one group = one Chrome window, this also closes the window and removes the group from persisted state.\n- `tabIds`: closes specific tab ids. Every id must belong to one of this extension's managed groups (any group, not just yours — but typically you'd only pass your own tabIds). Closing an unmanaged tab is rejected.\n\nChrome auto-removes a tab group when its last tab closes, and the extension's onRemoved listener drops the group from its persisted state automatically. The tool is idempotent: closing a group that doesn't exist is a no-op with a message.",
  {
    groupName: z.string().optional().describe("Name of the group whose tabs (and therefore window) to close. Mutually exclusive with tabIds."),
    tabIds: z.array(z.number()).optional().describe("Specific tab ids to close. Every id must belong to a managed group. Mutually exclusive with groupName."),
    profile: profileArg,
  },
  async (args) => callTool("close_tabs", args)
);

// 4. navigate
server.tool(
  "navigate",
  'Navigate to a URL, or go forward/back in browser history. If you don\'t have a valid tab ID, use tabs_context_mcp first to get available tabs.',
  {
    url: z.string().describe('The URL to navigate to. Can be provided with or without protocol (defaults to https://). Use "forward" to go forward in history or "back" to go back in history.'),
    tabId: z.number().describe("Tab ID to navigate. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
    profile: profileArg,
  },
  async (args) => callTool("navigate", args)
);

// 4. computer
server.tool(
  "computer",
  "Use a mouse and keyboard to interact with a web browser, and take screenshots. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.\n* Whenever you intend to click on an element like an icon, you should consult a screenshot to determine the coordinates of the element before moving the cursor.\n* If you tried clicking on a program or link but it failed to load, even after waiting, try adjusting your click location so that the tip of the cursor visually falls on the element that you want to click.\n* Make sure to click any buttons, links, icons, etc with the cursor tip in the center of the element. Don't click boxes on their edges unless asked.",
  {
    action: z.enum([
      "left_click", "right_click", "double_click", "triple_click",
      "type", "screenshot", "wait", "scroll", "key",
      "left_click_drag", "zoom", "scroll_to", "hover"
    ]).describe('The action to perform:\n* `left_click`: Click the left mouse button at the specified coordinates.\n* `right_click`: Click the right mouse button at the specified coordinates to open context menus.\n* `double_click`: Double-click the left mouse button at the specified coordinates.\n* `triple_click`: Triple-click the left mouse button at the specified coordinates.\n* `type`: Type a string of text.\n* `screenshot`: Take a screenshot of the screen.\n* `wait`: Wait for a specified number of seconds.\n* `scroll`: Scroll up, down, left, or right at the specified coordinates.\n* `key`: Press a specific keyboard key.\n* `left_click_drag`: Drag from start_coordinate to coordinate.\n* `zoom`: Take a screenshot of a specific region for closer inspection.\n* `scroll_to`: Scroll an element into view using its element reference ID from read_page or find tools.\n* `hover`: Move the mouse cursor to the specified coordinates or element without clicking. Useful for revealing tooltips, dropdown menus, or triggering hover states.'),
    tabId: z.number().describe("Tab ID to execute the action on. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
    coordinate: z.array(z.number()).min(2).max(2).optional().describe("(x, y): The x (pixels from the left edge) and y (pixels from the top edge) coordinates. Required for `left_click`, `right_click`, `double_click`, `triple_click`, and `scroll`. For `left_click_drag`, this is the end position."),
    duration: z.number().min(0).max(30).optional().describe("The number of seconds to wait. Required for `wait`. Maximum 30 seconds."),
    modifiers: z.string().optional().describe('Modifier keys for click actions. Supports: "ctrl", "shift", "alt", "cmd" (or "meta"), "win" (or "windows"). Can be combined with "+" (e.g., "ctrl+shift", "cmd+alt"). Optional.'),
    ref: z.string().optional().describe('Element reference ID from read_page or find tools (e.g., "ref_1", "ref_2"). Required for `scroll_to` action. Can be used as alternative to `coordinate` for click actions.'),
    region: z.array(z.number()).min(4).max(4).optional().describe("(x0, y0, x1, y1): The rectangular region to capture for `zoom`. Coordinates define a rectangle from top-left (x0, y0) to bottom-right (x1, y1) in pixels from the viewport origin. Required for `zoom` action. Useful for inspecting small UI elements like icons, buttons, or text."),
    repeat: z.number().min(1).max(100).optional().describe("Number of times to repeat the key sequence. Only applicable for `key` action. Must be a positive integer between 1 and 100. Default is 1. Useful for navigation tasks like pressing arrow keys multiple times."),
    scroll_direction: z.enum(["up", "down", "left", "right"]).optional().describe("The direction to scroll. Required for `scroll`."),
    scroll_amount: z.number().min(1).max(10).optional().describe("The number of scroll wheel ticks. Optional for `scroll`, defaults to 3."),
    start_coordinate: z.array(z.number()).min(2).max(2).optional().describe("(x, y): The starting coordinates for `left_click_drag`."),
    text: z.string().optional().describe('The text to type (for `type` action) or the key(s) to press (for `key` action). For `key` action: Provide space-separated keys (e.g., "Backspace Backspace Delete"). Supports keyboard shortcuts using the platform\'s modifier key (use "cmd" on Mac, "ctrl" on Windows/Linux, e.g., "cmd+a" or "ctrl+a" for select all).'),
    profile: profileArg,
  },
  async (args) => callTool("computer", args)
);

// 5. find
server.tool(
  "find",
  'Find elements on the page using natural language. Can search for elements by their purpose (e.g., "search bar", "login button") or by text content (e.g., "organic mango product"). Returns up to 20 matching elements with references that can be used with other tools. If more than 20 matches exist, you\'ll be notified to use a more specific query. If you don\'t have a valid tab ID, use tabs_context_mcp first to get available tabs.',
  {
    query: z.string().describe('Natural language description of what to find (e.g., "search bar", "add to cart button", "product title containing organic")'),
    tabId: z.number().describe("Tab ID to search in. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
    profile: profileArg,
  },
  async (args) => callTool("find", args)
);

// 6. form_input
server.tool(
  "form_input",
  "Set values in form elements using element reference ID from the read_page tool. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
  {
    ref: z.string().describe('Element reference ID from the read_page tool (e.g., "ref_1", "ref_2")'),
    value: z.union([z.string(), z.boolean(), z.number()]).describe("The value to set. For checkboxes use boolean, for selects use option value or text, for other inputs use appropriate string/number"),
    tabId: z.number().describe("Tab ID to set form value in. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
    profile: profileArg,
  },
  async (args) => callTool("form_input", args)
);

// 7. get_page_text
server.tool(
  "get_page_text",
  "Extract raw text content from the page, prioritizing article content. Ideal for reading articles, blog posts, or other text-heavy pages. Returns plain text without HTML formatting. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
  {
    tabId: z.number().describe("Tab ID to extract text from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
    profile: profileArg,
  },
  async (args) => callTool("get_page_text", args)
);

// 8. gif_creator
server.tool(
  "gif_creator",
  "Manage GIF recording and export for browser automation sessions. Control when to start/stop recording browser actions (clicks, scrolls, navigation), then export as an animated GIF with visual overlays (click indicators, action labels, progress bar, watermark). All operations are scoped to the tab's group. When starting recording, take a screenshot immediately after to capture the initial state as the first frame. When stopping recording, take a screenshot immediately before to capture the final state as the last frame. For export, either provide 'coordinate' to drag/drop upload to a page element, or set 'download: true' to download the GIF.",
  {
    action: z.enum(["start_recording", "stop_recording", "export", "clear"]).describe("Action to perform: 'start_recording' (begin capturing), 'stop_recording' (stop capturing but keep frames), 'export' (generate and export GIF), 'clear' (discard frames)"),
    tabId: z.number().describe("Tab ID to identify which tab group this operation applies to"),
    download: z.boolean().optional().describe("Always set this to true for the 'export' action only. This causes the gif to be downloaded in the browser."),
    filename: z.string().optional().describe("Optional filename for exported GIF (default: 'recording-[timestamp].gif'). For 'export' action only."),
    options: z.object({
      showClickIndicators: z.boolean().optional().describe("Show orange circles at click locations (default: true)"),
      showDragPaths: z.boolean().optional().describe("Show red arrows for drag actions (default: true)"),
      showActionLabels: z.boolean().optional().describe("Show black labels describing actions (default: true)"),
      showProgressBar: z.boolean().optional().describe("Show orange progress bar at bottom (default: true)"),
      showWatermark: z.boolean().optional().describe("Show watermark (default: true)"),
      quality: z.number().optional().describe("GIF compression quality, 1-30 (lower = better quality, slower encoding). Default: 10"),
    }).optional().describe("Optional GIF enhancement options for 'export' action. Properties: showClickIndicators (bool), showDragPaths (bool), showActionLabels (bool), showProgressBar (bool), showWatermark (bool), quality (number 1-30). All default to true except quality (default: 10)."),
    profile: profileArg,
  },
  async (args) => callTool("gif_creator", args)
);

// 8b. record — screen recording to a .webm file
server.tool(
  "record",
  "Record a screen video of the browser and save it as a .webm file — ideal for producing marketing/demo clips fully autonomously. Lifecycle: call action 'start' to begin, drive the browser with the other tools (navigate, computer click/scroll, etc.), then call action 'stop' to finish and download the video. Use action 'status' to check elapsed time. Only one recording runs at a time.\n\nSources:\n- 'tab' (default, FULLY AUTONOMOUS): records just the contents of one browser tab — no browser chrome, no OS picker, no human needed. Best for web app/page demos. Requires tabId.\n- 'area' (FULLY AUTONOMOUS): records a cropped rectangle of a tab. Requires tabId and region {x,y,width,height} in pixels of the captured frame.\n- 'screen' / 'window': records the whole screen or an app window. NOTE: Chrome forces a one-time native source picker that a human must click; this is the only non-autonomous source (a Chrome security limitation, unavoidable from an extension). Prefer 'tab'/'area' when you need zero human interaction.\n\nSet audio:true to also capture the tab's sound (the tab stays audible to the user).",
  {
    action: z.enum(["start", "stop", "status"]).describe("'start' begins recording, 'stop' finishes and saves the .webm, 'status' reports elapsed time."),
    source: z.enum(["tab", "area", "screen", "window"]).optional().describe("What to record. 'tab' (default) and 'area' are fully autonomous (no picker). 'screen'/'window' require a one-time native picker click."),
    tabId: z.number().optional().describe("Tab to record. Required for source 'tab' and 'area'."),
    region: z.object({
      x: z.number().describe("Left offset in pixels"),
      y: z.number().describe("Top offset in pixels"),
      width: z.number().describe("Crop width in pixels"),
      height: z.number().describe("Crop height in pixels"),
    }).optional().describe("Crop rectangle for source 'area', in pixels of the captured frame."),
    audio: z.boolean().optional().describe("Capture the tab's audio too (default false). The tab stays audible to the user."),
    fps: z.number().optional().describe("Frame rate, mainly for 'area' crop capture (default 30)."),
    videoBitsPerSecond: z.number().optional().describe("Target video bitrate, e.g. 2500000 for 2.5 Mbps. Higher = better quality and bigger file."),
    filename: z.string().optional().describe("Output filename for action 'stop' (default 'recording-<timestamp>.webm'). '.webm' is appended if missing."),
    mimeType: z.string().optional().describe("Preferred recording MIME, e.g. 'video/webm;codecs=vp9'. Falls back automatically if unsupported."),
    profile: profileArg,
  },
  async (args) => callTool("record", args)
);

// 9. javascript_tool
server.tool(
  "javascript_tool",
  "Execute JavaScript code in the context of the current page. The code runs in the page's context and can interact with the DOM, window object, and page variables. Returns the result of the last expression or any thrown errors. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
  {
    action: z.literal("javascript_exec").describe("Must be set to 'javascript_exec'"),
    text: z.string().describe("The JavaScript code to execute. The code will be evaluated in the page context. The result of the last expression will be returned automatically. Do NOT use 'return' statements - just write the expression you want to evaluate (e.g., 'window.myData.value' not 'return window.myData.value'). You can access and modify the DOM, call page functions, and interact with page variables."),
    tabId: z.number().describe("Tab ID to execute the code in. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
    profile: profileArg,
  },
  async (args) => callTool("javascript_tool", args)
);

// 10. read_console_messages
server.tool(
  "read_console_messages",
  "Read browser console messages (console.log, console.error, console.warn, etc.) from a specific tab. Useful for debugging JavaScript errors, viewing application logs, or understanding what's happening in the browser console. Returns console messages from the current domain only. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs. IMPORTANT: Always provide a pattern to filter messages - without a pattern, you may get too many irrelevant messages.",
  {
    tabId: z.number().describe("Tab ID to read console messages from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
    pattern: z.string().optional().describe("Regex pattern to filter console messages. Only messages matching this pattern will be returned (e.g., 'error|warning' to find errors and warnings, 'MyApp' to filter app-specific logs). You should always provide a pattern to avoid getting too many irrelevant messages."),
    limit: z.number().optional().describe("Maximum number of messages to return. Defaults to 100. Increase only if you need more results."),
    onlyErrors: z.boolean().optional().describe("If true, only return error and exception messages. Default is false (return all message types)."),
    clear: z.boolean().optional().describe("If true, clear the console messages after reading to avoid duplicates on subsequent calls. Default is false."),
    profile: profileArg,
  },
  async (args) => callTool("read_console_messages", args)
);

// 11. read_network_requests
server.tool(
  "read_network_requests",
  "Read HTTP network requests (XHR, Fetch, documents, images, etc.) from a specific tab. Useful for debugging API calls, monitoring network activity, or understanding what requests a page is making. Returns all network requests made by the current page, including cross-origin requests. Requests are automatically cleared when the page navigates to a different domain. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
  {
    tabId: z.number().describe("Tab ID to read network requests from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
    urlPattern: z.string().optional().describe("Optional URL pattern to filter requests. Only requests whose URL contains this string will be returned (e.g., '/api/' to filter API calls, 'example.com' to filter by domain)."),
    limit: z.number().optional().describe("Maximum number of requests to return. Defaults to 100. Increase only if you need more results."),
    clear: z.boolean().optional().describe("If true, clear the network requests after reading to avoid duplicates on subsequent calls. Default is false."),
    profile: profileArg,
  },
  async (args) => callTool("read_network_requests", args)
);

// 12. read_page
server.tool(
  "read_page",
  "Get an accessibility tree representation of elements on the page. By default returns all elements including non-visible ones. Output is limited to 50000 characters by default. If the output exceeds this limit, you will receive an error asking you to specify a smaller depth or focus on a specific element using ref_id. Optionally filter for only interactive elements. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
  {
    tabId: z.number().describe("Tab ID to read from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
    filter: z.enum(["interactive", "all"]).optional().describe('Filter elements: "interactive" for buttons/links/inputs only, "all" for all elements including non-visible ones (default: all elements)'),
    depth: z.number().optional().describe("Maximum depth of the tree to traverse (default: 15). Use a smaller depth if output is too large."),
    ref_id: z.string().optional().describe("Reference ID of a parent element to read. Will return the specified element and all its children. Use this to focus on a specific part of the page when output is too large."),
    max_chars: z.number().optional().describe("Maximum characters for output (default: 50000). Set to a higher value if your client can handle large outputs."),
    profile: profileArg,
  },
  async (args) => callTool("read_page", args)
);

// 13. resize_window
server.tool(
  "resize_window",
  "Resize the current browser window to specified dimensions. Useful for testing responsive designs or setting up specific screen sizes. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
  {
    width: z.number().describe("Target window width in pixels"),
    height: z.number().describe("Target window height in pixels"),
    tabId: z.number().describe("Tab ID to get the window for. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
    profile: profileArg,
  },
  async (args) => callTool("resize_window", args)
);

// 14. shortcuts_list
server.tool(
  "shortcuts_list",
  "List all available shortcuts and workflows (shortcuts and workflows are interchangeable). Returns shortcuts with their commands, descriptions, and whether they are workflows. Use shortcuts_execute to run a shortcut or workflow.",
  {
    tabId: z.number().describe("Tab ID to list shortcuts from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
    profile: profileArg,
  },
  async (args) => callTool("shortcuts_list", args)
);

// 15. shortcuts_execute
server.tool(
  "shortcuts_execute",
  "Execute a shortcut or workflow by running it in a new sidepanel window using the current tab (shortcuts and workflows are interchangeable). Use shortcuts_list first to see available shortcuts. This starts the execution and returns immediately - it does not wait for completion.",
  {
    tabId: z.number().describe("Tab ID to execute the shortcut on. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
    shortcutId: z.string().optional().describe("The ID of the shortcut to execute"),
    command: z.string().optional().describe("The command name of the shortcut to execute (e.g., 'debug', 'summarize'). Do not include the leading slash."),
    profile: profileArg,
  },
  async (args) => callTool("shortcuts_execute", args)
);

// 16. list_browsers
server.tool(
  "list_browsers",
  "List the Chrome profiles currently connected to this MCP server. Each profile is a separate browser profile that loaded the extension and self-reported a label (set in the extension's Options page). Returns each profile's label, version, and which one is the active routing target for THIS session. Use the returned label with switch_browser, or pass it as the `profile` argument to any browser tool. When only one profile is connected, everything routes to it automatically and you don't need this.",
  {},
  async () => {
    if (mode === "primary") return textResult(JSON.stringify(browsersInfo("local"), null, 2));
    return callTool("list_browsers", {});
  }
);

// 17. switch_browser
server.tool(
  "switch_browser",
  "Choose which connected Chrome profile subsequent browser tools target for THIS session. Pass a `profile` label from list_browsers. The selection is per-session, so it won't disturb other client sessions (Claude Code, Codex, Antigravity) sharing the same browser. You can also override per-call with the `profile` argument on individual tools instead of switching. Only needed when more than one profile is connected.",
  {
    profile: z.string().describe("The profile label to make active for this session (from list_browsers)."),
  },
  async (args) => {
    if (mode === "primary") {
      try {
        const label = setTarget("local", args.profile);
        return textResult(`Switched to browser profile "${label}".\n\n` + JSON.stringify(browsersInfo("local"), null, 2));
      } catch (e) {
        return textResult(`Error: ${e.message}`);
      }
    }
    return callTool("switch_browser", args);
  }
);

// 17. update_plan
server.tool(
  "update_plan",
  "Present a plan to the user for approval before taking actions. The user will see the domains you intend to visit and your approach. Once approved, you can proceed with actions on the approved domains without additional permission prompts.",
  {
    domains: z.array(z.string()).describe("List of domains you will visit (e.g., ['github.com', 'stackoverflow.com']). These domains will be approved for the session when the user accepts the plan."),
    approach: z.array(z.string()).describe("High-level description of what you will do. Focus on outcomes and key actions, not implementation details. Be concise - aim for 3-7 items."),
  },
  async (args) => callTool("update_plan", args)
);

// 18. upload_image
server.tool(
  "upload_image",
  "Upload a previously captured screenshot or user-uploaded image to a file input or drag & drop target. Supports two approaches: (1) ref - for targeting specific elements, especially hidden file inputs, (2) coordinate - for drag & drop to visible locations like Google Docs. Provide either ref or coordinate, not both.",
  {
    imageId: z.string().describe("ID of a previously captured screenshot (from the computer tool's screenshot action) or a user-uploaded image"),
    tabId: z.number().describe("Tab ID where the target element is located. This is where the image will be uploaded to."),
    ref: z.string().optional().describe('Element reference ID from read_page or find tools (e.g., "ref_1", "ref_2"). Use this for file inputs (especially hidden ones) or specific elements. Provide either ref or coordinate, not both.'),
    coordinate: z.array(z.number()).optional().describe("Viewport coordinates [x, y] for drag & drop to a visible location. Use this for drag & drop targets like Google Docs. Provide either ref or coordinate, not both."),
    filename: z.string().optional().describe('Optional filename for the uploaded file (default: "image.png")'),
    profile: profileArg,
  },
  async (args) => callTool("upload_image", args)
);

// 18b. set_input_files
server.tool(
  "set_input_files",
  "Attach one or more LOCAL files (any type — video, image, pdf, zip, etc.) to a file <input> on the page by reading them straight off disk via CDP DOM.setFileInputFiles. This is the reliable way to upload a file: it bypasses the native OS file picker entirely (no dialog, no folder navigation, no tab-focus stealing) and works even when the page's CSP blocks fetch-based injection (e.g. TikTok Studio, YouTube Studio). The browser dispatches the real input/change events, so the site's upload starts as if the user had picked the file. Provide ABSOLUTE paths. The file input is often visually hidden — you usually don't need to click 'Select video' first; just target it by selector.",
  {
    tabId: z.number().describe("Tab ID containing the file input (from tabs_context_mcp). The tab must be in an MCP-managed tab group."),
    files: z.array(z.string()).describe("Absolute path(s) of the local file(s) to attach, e.g. ['/Users/me/clip.mp4']. Most inputs accept a single file."),
    selector: z.string().optional().describe('CSS selector for the target file input (default "input[type=file]"). The first match is used.'),
    profile: profileArg,
  },
  async (args) => callTool("set_input_files", args)
);

// 18c. insert_text
server.tool(
  "insert_text",
  "Set the text of a rich-text/contenteditable editor (DraftJS, Lexical, Slate, etc.) or a plain input/textarea in ONE shot via execCommand('insertText'). Use this instead of the `type` action for captions/descriptions on sites like TikTok Studio: typing char-by-char races the editor's internal state + autocomplete dropdown and scrambles or duplicates the text. This inserts the whole string atomically (handles Vietnamese diacritics + emoji), and with clear=true it replaces the existing content. NOTE: to dismiss a hashtag/mention suggestion popup afterward, click a neutral spot — do NOT press Escape (it can duplicate the hashtag block).",
  {
    tabId: z.number().describe("Tab ID containing the editor (from tabs_context_mcp)."),
    selector: z.string().describe('CSS selector of the editor, e.g. \'.public-DraftEditor-content[contenteditable="true"]\' for TikTok, or any [contenteditable="true"] / input / textarea.'),
    text: z.string().describe("The full text to insert (replaces existing content when clear=true)."),
    clear: z.boolean().optional().describe("Select existing content first so the insert replaces it. Default true."),
    blur: z.boolean().optional().describe("Blur the editor after inserting (helps dismiss suggestion popups without pressing Escape). Default true."),
    profile: profileArg,
  },
  async (args) => callTool("insert_text", args)
);

// 19. debug_extension
server.tool(
  "debug_extension",
  "Run code INSIDE another extension's own context via the debugger Target API — the reliable way to seed/read that extension's chrome.storage, call its internal handlers, or otherwise do what its UI/keyboard-shortcut would do (things the page-level computer/navigate/javascript tools can't reach, because storage is per-extension and chrome.commands are browser-level). Actions:\n* `list_targets`: list debuggable targets (service workers, options/popup pages). Filter by `extensionId` and/or `targetType`. Use this first to discover targets and confirm the service worker is awake.\n* `eval`: attach to a target and evaluate a JS `expression` in that extension's context (chrome.* APIs available), then detach. Provide `targetId` (from list_targets) OR `extensionId` (auto-picks the service worker). Awaits promises by default and returns the value.\nNOTES: a target's service worker must be ACTIVE to appear/attach — wake it via its popup/options if inactive. Attaching to other extensions may require Chrome started with --silent-debugger-extension-api. Policy-installed extensions can't be attached.",
  {
    action: z.enum(["list_targets", "eval"]).describe("'list_targets' to discover targets; 'eval' to run code in a target."),
    extensionId: z.string().optional().describe("Target extension's ID (32 chars a–p). For list_targets: filter to this extension. For eval: auto-selects its service worker if targetId is omitted."),
    targetId: z.string().optional().describe("Specific debugger targetId (from list_targets) to attach to for eval. Takes precedence over extensionId."),
    targetType: z.string().optional().describe("For list_targets: filter by type, e.g. 'service_worker', 'page', 'background_page'."),
    expression: z.string().optional().describe("For eval: the JavaScript expression to evaluate inside the target's context. Can use chrome.* APIs and chrome.storage. Example: \"chrome.storage.local.set({activeProfile:{...}})\"."),
    awaitPromise: z.boolean().optional().describe("For eval: await the expression if it returns a promise. Default true."),
    profile: profileArg,
  },
  async (args) => callTool("debug_extension", args)
);

// 20. manage_extensions
server.tool(
  "manage_extensions",
  "Inspect and control installed Chrome extensions via the chrome.management API — the reliable way to do what you'd otherwise do on the chrome://extensions page (which cannot be driven by the debugger/computer tools). Actions:\n* `list`: return all installed extensions (id, name, version, enabled, type, installType, mayDisable).\n* `get`: details for one extension (requires `id`).\n* `enable` / `disable`: toggle an extension on/off (requires `id`).\n* `uninstall`: remove an extension (requires `id`; shows Chrome's native confirm dialog by default).\n* `reload`: reload an extension to pick up new code. With no `id` (or this extension's own id) it reloads THIS Agent Chrome MCP extension — use after editing extension code (background/offscreen/popup/manifest); it also rebuilds the native-host bridge. With another `id` it reloads that extension via disable→enable. The connection drops for a moment; if the next call errors, wait briefly and retry.\n* `reconnect`: re-establish just the extension↔native-host↔mcp-server bridge without reloading (lighter than `reload`); use when the bridge is stuck.\nThis extension refuses to disable or uninstall itself.\nNOTE: none of these restart the MCP server process itself — reconnect it in your MCP client to pick up server-code changes.",
  {
    action: z.enum(["list", "get", "enable", "disable", "uninstall", "reload", "reconnect"]).describe("The management action to perform."),
    id: z.string().optional().describe("The target extension's ID. Required for get/enable/disable/uninstall; optional for reload (omit to reload this extension). Get IDs from action 'list'."),
    showConfirmDialog: z.boolean().optional().describe("For 'uninstall' only: show Chrome's native confirmation dialog. Default true (safer). Set false to uninstall without prompting."),
    profile: profileArg,
  },
  async (args) => callTool("manage_extensions", args)
);

// 20b. relay_fetch
server.tool(
  "relay_fetch",
  "Relay an arbitrary HTTP request through a real browser tab in the target origin (same-origin fetch + cookies + browser TLS fingerprint). Bypasses Cloudflare/anti-bot gates (e.g. Udemy, Hosocongty, Masothue, etc.) that reject server-side fetch/curl with HTTP 403 Forbidden. Can run in a specified tab or automatically find/open a tab matching the target origin.",
  {
    url: z.string().describe("The URL to fetch (e.g. 'https://www.udemy.com/api-2.0/users/me/taught-profile-courses/' or GraphQL endpoint)."),
    method: z.string().optional().describe("HTTP method: GET, POST, PUT, DELETE, PATCH, etc. Default is GET."),
    headers: z.record(z.string(), z.string()).optional().describe("Key-value pairs of request headers (e.g. {'Content-Type': 'application/json'})."),
    body: z.string().optional().describe("Request body for POST/PUT requests (JSON string, GraphQL query body, etc.)."),
    origin: z.string().optional().describe("Target origin (e.g. 'https://www.udemy.com'). If omitted, extracted from url."),
    tabId: z.number().optional().describe("Specific tab ID to execute the fetch in. If omitted, automatically finds an open tab matching the origin or creates one."),
    openIfMissing: z.boolean().optional().describe("If true and no matching tab is open, open a background tab to the origin and wait for it to load. Default is true."),
    navigateTab: z.boolean().optional().describe("If true, navigate the target tab directly to the URL before executing in-page script."),
    extractSearchResults: z.boolean().optional().describe("If true, parse and extract member search result cards from the page DOM."),
    profile: profileArg,
  },
  async (args) => callTool("relay_fetch", args)
);


// 21. healthcheck
//
// Composes mcp-server's local state + a best-effort probe of the extension.
// Always returns local state even if the extension is unreachable, plus an
// `advice` string with concrete next steps. Agents should call this BEFORE
// falling back to another browser MCP — it distinguishes transient issues
// (extension reconnecting) from permanent ones (extension not installed).
server.tool(
  "healthcheck",
  "Diagnose the Agent Chrome MCP stack. Returns: mcp-server mode + bind address, native-host connection status with timestamps, pending-request count, connected-client count, plus a best-effort probe of the extension itself (groups, attached tabs, version). Always returns local state even if the extension is unreachable. Includes an `advice` string with concrete next steps. Call this BEFORE falling back to another browser tool — it distinguishes transient issues (worker reconnecting, retry in a few seconds) from permanent ones (extension not installed, run scripts/install.sh).",
  {},
  async () => {
    const isPrimary = mode === "primary";
    const local = {
      mode,
      bindAddress: "127.0.0.1",
      port: TCP_PORT,
      pid: process.pid,
      pidfilePath,
      uptimeSeconds: Math.floor((Date.now() - serverStartedAt) / 1000),
      pendingRequestsCount: pendingRequests.size,
      // Primary-only fields. In client mode these are meaningless (the client
      // never accepts a native host connection; the primary does) so omitting
      // them avoids the misleading `nativeHostEverConnected: false` report.
      ...(isPrimary ? {
        nativeHostSocketConnected: nativeHosts.size > 0,
        connectedProfilesCount: nativeHosts.size,
        connectedProfiles: [...nativeHosts.keys()],
        activeProfile: browsersInfo("local").activeProfile,
        nativeHostEverConnected,
        lastNativeHostConnectAt: lastNativeHostConnectAt ? new Date(lastNativeHostConnectAt).toISOString() : null,
        lastNativeHostConnectAgo: fmtAgo(lastNativeHostConnectAt),
        lastNativeHostDisconnectAt: lastNativeHostDisconnectAt ? new Date(lastNativeHostDisconnectAt).toISOString() : null,
        lastNativeHostDisconnectAgo: fmtAgo(lastNativeHostDisconnectAt),
        lastNativeHostMessageAt: lastNativeHostMessageAt ? new Date(lastNativeHostMessageAt).toISOString() : null,
        lastNativeHostMessageAgo: fmtAgo(lastNativeHostMessageAt),
        connectedClientsCount: clientSockets.size,
      } : {}),
      // Client-only
      ...(isPrimary ? {} : {
        primarySocketAlive: !!(primarySocket && !primarySocket.destroyed),
        clientReconnectAttempts,
      }),
    };

    let extension = null;
    let extensionReachable = false;
    let extensionError = null;

    // Unwrap the MCP content envelope: extension handlers return
    // { content: [{ type: "text", text: "<json>" }] }. We want the parsed
    // inner object, not the envelope.
    const unwrap = (probe) => {
      if (probe && Array.isArray(probe.content) && probe.content[0]?.type === "text") {
        try { return JSON.parse(probe.content[0].text); }
        catch { return { raw: probe.content[0].text }; }
      }
      return probe;
    };
    // Short timeout (5s) so a hung extension doesn't make healthcheck slow.
    const probeOnce = (args) => Promise.race([
      sendToExtension("healthcheck", args),
      new Promise((_, reject) => setTimeout(() => reject(new Error("extension probe timed out (5s) — service worker may be evicted")), 5000)),
    ]);

    if (isPrimary && nativeHosts.size > 1) {
      // Probe each connected profile individually so one hung profile doesn't
      // mask the others, and report results keyed by label.
      const perProfile = {};
      for (const label of nativeHosts.keys()) {
        try {
          perProfile[label] = unwrap(await probeOnce({ profile: label }));
          extensionReachable = true;
        } catch (err) {
          perProfile[label] = { error: err.message };
        }
      }
      extension = perProfile;
      if (!extensionReachable) extensionError = "all connected profiles failed to respond to the probe";
    } else {
      try {
        extension = unwrap(await probeOnce({}));
        extensionReachable = true;
      } catch (err) {
        extensionError = err.message;
      }
    }

    let advice;
    if (extensionReachable) {
      advice = "All systems healthy. Agent Chrome MCP is fully operational.";
    } else if (mode === "client") {
      // A client healthcheck probe that fails can mean two things:
      //   (a) our TCP link to the primary is broken (we're retrying,
      //       possibly self-promoting) — primarySocketAlive tells us
      //   (b) the primary routed our request to its native host and got an
      //       error back (extension side issue, same as a primary-mode failure)
      if (!local.primarySocketAlive) {
        advice = `CLIENT: this mcp-server is running as a client of another primary on :${TCP_PORT}, ` +
          `but the TCP link to the primary is currently down (${clientReconnectAttempts} failed reconnects). ` +
          `After ${PROMOTE_AFTER_FAILED_RECONNECTS} failed reconnects this client will try to promote itself to primary. ` +
          "If still stuck: stop the configured Agent Chrome MCP server process and reconnect your client — the fresh spawn will become primary and a new native-host connection from the " +
          "extension will land there cleanly.";
      } else {
        advice = "CLIENT: TCP link to the primary is healthy, but the primary's extension probe failed. " +
          "The primary's native host is down (extension disconnected from browser side). " +
          `Primary error: ${extensionError}. ` +
          "Fix on the primary: open any tab in Chrome to wake the service worker, or reload the extension at chrome://extensions.";
      }
    } else if (!nativeHostEverConnected) {
      advice = "PERMANENT: extension has never connected to this MCP server. " +
        "Open Chrome / Brave / Edge, ensure the Agent Chrome MCP extension is enabled at chrome://extensions, " +
        "and verify scripts/install.sh has been run for that extension's ID. " +
        "Do NOT silently fall back — tell the user the extension is missing and ask them to fix it.";
    } else if (!local.nativeHostSocketConnected) {
      advice = "TRANSIENT: extension was connected but the native messaging host is currently dropped " +
        `(disconnected ${local.lastNativeHostDisconnectAgo}). ` +
        "Likely the Chrome service worker was evicted. Open any browser tab to wake it, " +
        "then retry in a few seconds. The keep-alive alarm reconnects every ~24s automatically.";
    } else {
      advice = "Native host is connected but the extension didn't respond to the probe. " +
        "Service worker may be hung — reload the extension at chrome://extensions. " +
        `Probe error: ${extensionError}`;
    }

    return textResult(JSON.stringify({
      mcpServer: local,
      extensionReachable,
      extension,
      extensionError,
      advice,
    }, null, 2));
  }
);

// --- Start MCP server ---

const transport = new StdioServerTransport();
await server.connect(transport);
