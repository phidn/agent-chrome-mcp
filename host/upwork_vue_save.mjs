import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function run() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["/Volumes/Lexar_E6/davis/projects/agent-chrome-mcp/host/mcp-server.js"]
  });
  const client = new Client({ name: "upwork-vue-fix-final", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  await new Promise(r => setTimeout(r, 1000));

  const p = "davis";
  const tabId = 1628055298;

  const newOverview = `I am a Software Engineer with over 5 years of deep domain experience in CRM and enterprise management systems — from data pipeline standardization to intelligent automation with AI Agents. Focused on core engineering intuition and solving practical problems from first principles, I embrace lifelong learning as my core value, taking every complex challenge as an opportunity to compound knowledge and craft sustainable products.

Three core lessons learned across three distinct environments:
1/ ArenaCommerce (Product & Outsource): "Done is better than perfect" — prioritize relentless execution and delivering tangible real-world value.
2/ Blackwind Software (Pure Outsource): "Timeline is king" — keeping project delivery strictly under control is everything, regardless of Scrum, Kanban, Agile, or Waterfall.
3/ OplaCRM (Pure Product): "Enjoy your work" — my most cherished chapter, where "Culture" was the most profound takeaway.

What I build:
• Custom CRM & B2B SaaS — pipelines, lead & deal scoring, healthscore, reporting, dashboards.
• Intelligent AI Agents & Workflows — automated workflows with Claude Code skills, MCP tools, and production LLMs.
• Integrations & APIs — connect CRM/SaaS to external tools (Shopify, Airtable, ERPs, webhooks) with clean, reliable data sync.
• High-concurrency systems — React, Next.js, React Native, Node.js / NestJS, Golang, PostgreSQL, Hasura.

Track record:
• 2.5 years building OplaCRM / OplaGO for enterprise sales teams (Top Performer).
• Web Team Lead delivering ShopDunk ERP + iPhone 15 pre-order campaign (5,000+ orders on day one).
• Shipped features for a Shopify app used by 10,000+ active merchant stores globally.

Portfolio & Case Studies: https://phidang.work`;

  const script = `
    (async () => {
      const textarea = document.querySelector("#profile-description, textarea");
      if (!textarea) return "No textarea";

      textarea._value = ${JSON.stringify(newOverview)};
      textarea.value = ${JSON.stringify(newOverview)};
      
      const inputEvent = new Event("input", { bubbles: true, cancelable: true });
      textarea.dispatchEvent(inputEvent);
      
      const changeEvent = new Event("change", { bubbles: true, cancelable: true });
      textarea.dispatchEvent(changeEvent);

      await new Promise(r => setTimeout(r, 500));

      const modal = document.querySelector('div[role="dialog"], .air3-modal');
      const saveBtn = modal ? modal.querySelector("button.air3-btn-primary") : null;
      if (saveBtn) {
        saveBtn.click();
        return "Clicked Save with _value updated!";
      }
      return "Save btn not found";
    })()
  `;

  const saveRes = await client.callTool({
    name: "javascript_tool",
    arguments: {
      action: "javascript_exec",
      tabId,
      profile: p,
      text: script
    }
  });
  console.log("Save result:", saveRes.content?.[1]?.text || saveRes.content?.[0]?.text);

  await new Promise(r => setTimeout(r, 4000));

  // Verify
  const checkRes = await client.callTool({
    name: "javascript_tool",
    arguments: {
      action: "javascript_exec",
      tabId,
      profile: p,
      text: `(() => {
        const text = document.body.innerText;
        return JSON.stringify({
          hasNewText: text.includes("I am a Software Engineer with over 5 years"),
          hasOldText: text.includes("I build and scale custom B2B CRM and SaaS products")
        });
      })()`
    }
  });
  console.log("Check live status:\n", checkRes.content?.[1]?.text || checkRes.content?.[0]?.text);

  process.exit(0);
}
run().catch(console.error);
