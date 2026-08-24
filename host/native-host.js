#!/usr/bin/env node

// Native Messaging Host for Agent Chrome MCP extension.
// Launched by Chrome when the extension calls connectNative().
// Bridges between Chrome native messaging (stdin/stdout, 4-byte LE length prefix + JSON)
// and the MCP server (TCP on localhost).

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_PORT = 18766;

function getPort() {
  const configPath = path.join(
    os.homedir(),
    ".config",
    "agent-chrome-mcp",
    "config.json"
  );
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return config.port || DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

// --- Native messaging protocol (Chrome <-> this process) ---

function readNativeMessage(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const len = buffer.readUInt32LE(offset);
    if (offset + 4 + len > buffer.length) break;
    const json = buffer.subarray(offset + 4, offset + 4 + len).toString("utf-8");
    try {
      messages.push(JSON.parse(json));
    } catch (e) {
      // skip malformed
    }
    offset += 4 + len;
  }
  return { messages, remainder: buffer.subarray(offset) };
}

function writeNativeMessage(obj) {
  const json = JSON.stringify(obj);
  const buf = Buffer.from(json, "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(buf.length, 0);
  process.stdout.write(Buffer.concat([header, buf]));
}

// --- TCP connection to MCP server ---

let tcpSocket = null;
let tcpConnected = false;
let tcpBuffer = Buffer.alloc(0);
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 60; // 30 seconds at 500ms intervals
const TCP_PORT = getPort();

// Messages from the extension that arrive before the TCP link to the MCP server
// is up must not be dropped — the very first one is usually host_hello, which
// carries this profile's label. Queue them and flush once connected.
const pendingToServer = [];
// Remember the latest host_hello so we can replay it on every (re)connect: the
// MCP server may start AFTER us, or restart, and would otherwise never learn our
// label (the extension only sends host_hello once per native-port lifetime).
let lastHostHello = null;

function sendToServer(msg) {
  if (msg && msg.type === "host_hello") lastHostHello = msg;
  if (tcpConnected && tcpSocket && !tcpSocket.destroyed) {
    tcpSocket.write(JSON.stringify(msg) + "\n");
  } else {
    pendingToServer.push(msg);
  }
}

function connectTcp() {
  if (tcpSocket) return;

  tcpSocket = new net.Socket();

  tcpSocket.connect(TCP_PORT, "127.0.0.1", () => {
    tcpConnected = true;
    reconnectAttempts = 0;
    if (reconnectTimer) {
      clearInterval(reconnectTimer);
      reconnectTimer = null;
    }
    // Re-announce our label first, then flush anything buffered while offline.
    if (lastHostHello) tcpSocket.write(JSON.stringify(lastHostHello) + "\n");
    while (pendingToServer.length) {
      const msg = pendingToServer.shift();
      if (msg === lastHostHello) continue; // already sent above
      tcpSocket.write(JSON.stringify(msg) + "\n");
    }
  });

  tcpSocket.on("data", (chunk) => {
    // newline-delimited JSON from MCP server
    tcpBuffer = Buffer.concat([tcpBuffer, chunk]);
    let newlineIdx;
    while ((newlineIdx = tcpBuffer.indexOf(10)) !== -1) {
      const line = tcpBuffer.subarray(0, newlineIdx).toString("utf-8").trim();
      tcpBuffer = tcpBuffer.subarray(newlineIdx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        // Forward to extension via native messaging
        writeNativeMessage(msg);
      } catch {
        // skip malformed
      }
    }
  });

  tcpSocket.on("error", () => {
    tcpConnected = false;
    tcpSocket = null;
  });

  tcpSocket.on("close", () => {
    tcpConnected = false;
    tcpSocket = null;
    if (!reconnectTimer) {
      reconnectTimer = setInterval(() => {
        reconnectAttempts++;
        if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
          // MCP server is gone — exit cleanly so we don't linger as a zombie
          clearInterval(reconnectTimer);
          process.exit(0);
        }
        if (!tcpSocket) connectTcp();
      }, 500);
    }
  });
}

// --- Main: bridge stdin (from extension) <-> TCP (to MCP server) ---

let stdinBuffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
  const { messages, remainder } = readNativeMessage(stdinBuffer);
  stdinBuffer = remainder;

  for (const msg of messages) {
    // Forward to MCP server (buffered if the link isn't up yet).
    sendToServer(msg);
  }
});

process.stdin.on("end", () => {
  // Extension disconnected
  if (tcpSocket) tcpSocket.destroy();
  process.exit(0);
});

// Start TCP connection
connectTcp();
