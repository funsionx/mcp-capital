import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const t = new StdioClientTransport({ command: "bun", args: ["run", "src/index.ts", "--stdio"], env: { ...process.env, DB_PATH: "/tmp/pf-boot.db" } as Record<string,string> });
const c = new Client({ name: "boot", version: "1.0.0" }); await c.connect(t);
const tools = (await c.listTools()).tools.map(x=>x.name);
console.log("tools (" + tools.length + "):", tools.join(", "));
await c.close();
