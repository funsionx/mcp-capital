/**
 * Smoke test: spawn the MCP server, list tools, and invoke get_portfolio_summary.
 * Network-dependent sources may error in a sandbox — that's fine; we only assert
 * the protocol wiring and the response envelope shape.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "bun",
  args: ["run", "src/index.ts", "--stdio"],
});
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name));

const res = await client.callTool({
  name: "get_portfolio_summary",
  arguments: { includeSources: ["static", "moex"] },
});
const text = (res.content as { type: string; text: string }[])[0]?.text ?? "";
const parsed = JSON.parse(text);
console.log("KEYS:", Object.keys(parsed));
console.log("positionCount:", parsed.positionCount);
console.log("errors:", JSON.stringify(parsed.errors));
console.log("positions:", JSON.stringify(parsed.positions, null, 2).slice(0, 800));

await client.close();
