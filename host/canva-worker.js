import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "fs";

export async function getClient() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["/Volumes/Lexar_E6/davis/projects/agent-chrome-mcp/host/mcp-server.js"]
  });
  const client = new Client({ name: "cli", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

export async function screenshot(client, tabId, filename = "scratch-canva-screen.png") {
  const res = await client.callTool({
    name: "computer",
    arguments: {
      action: "screenshot",
      tabId,
      profile: "phidndev"
    }
  });
  for (const item of res.content) {
    if (item.type === "image") {
      fs.writeFileSync(`/Volumes/Lexar_E6/davis/projects/tieuvienhuuthu/marketing/${filename}`, Buffer.from(item.data, "base64"));
      console.log(`Saved screenshot to ${filename}`);
    }
  }
}

export async function click(client, tabId, x, y) {
  console.log(`Clicking at (${x}, ${y})`);
  await client.callTool({
    name: "computer",
    arguments: {
      action: "left_click",
      coordinate: [x, y],
      tabId,
      profile: "phidndev"
    }
  });
  await new Promise(r => setTimeout(r, 1000));
}

export async function doubleClick(client, tabId, x, y) {
  console.log(`Double clicking at (${x}, ${y})`);
  await client.callTool({
    name: "computer",
    arguments: {
      action: "double_click",
      coordinate: [x, y],
      tabId,
      profile: "phidndev"
    }
  });
  await new Promise(r => setTimeout(r, 1000));
}

export async function keyPress(client, tabId, key) {
  console.log(`Pressing key: ${key}`);
  await client.callTool({
    name: "computer",
    arguments: {
      action: "key",
      text: key,
      tabId,
      profile: "phidndev"
    }
  });
  await new Promise(r => setTimeout(r, 1000));
}

export async function typeText(client, tabId, text) {
  console.log(`Typing: ${text}`);
  await client.callTool({
    name: "computer",
    arguments: {
      action: "type",
      text,
      tabId,
      profile: "phidndev"
    }
  });
  await new Promise(r => setTimeout(r, 1000));
}
