import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function run() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["/Volumes/Lexar_E6/davis/projects/agent-chrome-mcp/host/mcp-server.js"]
  });
  const client = new Client({ name: "upwork-debug-overview", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  await new Promise(r => setTimeout(r, 1000));

  const p = "davis";
  const tabId = 1628055298;

  // 1. Click edit description
  await client.callTool({
    name: "javascript_tool",
    arguments: {
      action: "javascript_exec",
      tabId,
      profile: p,
      text: `(() => {
        const btn = document.querySelector('button[aria-label="Edit description"]');
        if (btn) btn.click();
      })()`
    }
  });

  await new Promise(r => setTimeout(r, 2000));

  // 2. Intercept fetch/XHR inside page to see what Upwork is sending or why it fails
  const debugScript = `
    (() => {
      const textarea = document.querySelector('#profile-description, textarea');
      const modal = document.querySelector('div[role="dialog"], .air3-modal');
      const saveBtn = modal ? modal.querySelector('button.air3-btn-primary') : null;
      
      const charCount = modal ? modal.querySelector('.air3-counter, [class*=counter], [class*=count]')?.innerText : null;
      const errorMsg = modal ? modal.querySelector('.air3-alert, [class*=error], [class*=alert]')?.innerText : null;

      return JSON.stringify({
        textareaLen: textarea ? textarea.value.length : null,
        charCount,
        errorMsg,
        saveBtnDisabled: saveBtn ? saveBtn.disabled : null
      });
    })()
  `;

  const debugRes = await client.callTool({
    name: "javascript_tool",
    arguments: {
      action: "javascript_exec",
      tabId,
      profile: p,
      text: debugScript
    }
  });
  console.log("Debug details:\n", debugRes.content?.[1]?.text || debugRes.content?.[0]?.text);

  process.exit(0);
}
run().catch(console.error);
