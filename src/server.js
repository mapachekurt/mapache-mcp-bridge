import express from "express";
import cors from "cors";
import {
  Agent,
  run,
  hostedMcpTool,
  MCPServerStreamableHttp,
  MCPServerStdio
} from "@openai/agents";

/**
 * ENV:
 *  OPENAI_API_KEY                (required)
 *  MCP_HOSTED_LABELS_URLS        (optional) e.g. linear=https://<linear-mcp>/mcp
 *  MCP_STREAMABLE_URLS           (optional) e.g. https://<n8n-mcp-sse>.railway.app
 *  MCP_STDIO_COMMANDS            (optional) e.g. "npx -y @modelcontextprotocol/server-filesystem ./data"
 *  AGENT_NAME                    (optional)
 *  AGENT_INSTRUCTIONS            (optional)
 */
const app = express();
app.use(cors());
app.use(express.json({ limit: "4mb" }));

async function buildAgent() {
  const tools = [];
  const mcpServers = [];

  // Hosted HTTP MCP servers (Responses API executes remote tools)
  (process.env.MCP_HOSTED_LABELS_URLS || "")
    .split(",").map(s => s.trim()).filter(Boolean)
    .forEach(pair => {
      const [label, url] = pair.split("=").map(x => x.trim());
      tools.push(hostedMcpTool({ serverLabel: label, serverUrl: url }));
    });

  // Streamable HTTP/SSE MCP servers (SDK talks directly)
  (process.env.MCP_STREAMABLE_URLS || "")
    .split(",").map(s => s.trim()).filter(Boolean)
    .forEach(url => {
      mcpServers.push(new MCPServerStreamableHttp({ url, name: `http-${new URL(url).hostname}` }));
    });

  // stdio MCP servers
  (process.env.MCP_STDIO_COMMANDS || "")
    .split(",").map(s => s.trim()).filter(Boolean)
    .forEach(fullCommand => {
      mcpServers.push(new MCPServerStdio({ name: `stdio-${Date.now()}`, fullCommand }));
    });

  const agent = new Agent({
    name: process.env.AGENT_NAME || "Mapache MCP Bridge",
    instructions: process.env.AGENT_INSTRUCTIONS ||
      "Use MCP tools when available. Prefer precise tool calls over guesses.",
    tools,
    mcpServers
  });

  for (const s of mcpServers) await s.connect();
  return agent;
}

const agent = await buildAgent();

app.post("/run", async (req, res) => {
  try {
    const userInput = req.body?.prompt ?? "";
    const result = await run(agent, userInput, { stream: false });
    res.json({
      output: result.finalOutput,
      toolEvents: result.toolEvents ?? [],
      citations: result.citations ?? []
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.get("/healthz", (_, res) => res.send("ok"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`MCP bridge listening on :${port}`));
