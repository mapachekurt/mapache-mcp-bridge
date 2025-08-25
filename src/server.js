import express from "express";
import cors from "cors";
import {
  Agent,
  run,
  hostedMcpTool,
  MCPServerStreamableHttp,
  MCPServerStdio,
} from "@openai/agents";

const app = express();
app.use(cors());
app.use(express.json({ limit: "4mb" }));

let agent;
let connected = { hosted: [], streamable: [] };
let servers = [];

// Build (or rebuild) the agent and attach MCP servers if configured
async function buildAgent() {
  const tools = [];
  connected = { hosted: [], streamable: [] };
  servers = [];

  // Hosted HTTP MCP servers (executed by the Responses API)
  (process.env.MCP_HOSTED_LABELS_URLS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((pair) => {
      const [label, url] = pair.split("=").map((x) => x.trim());
      tools.push(hostedMcpTool({ serverLabel: label, serverUrl: url }));
      connected.hosted.push({ label, url });
    });

  // Streamable HTTP/SSE MCP servers (SDK connects directly)
  (process.env.MCP_STREAMABLE_URLS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((url) => {
      const name = `http-${new URL(url).hostname}`;
      servers.push(new MCPServerStreamableHttp({ url, name }));
      connected.streamable.push({ name, url });
    });

  // stdio MCP servers
  (process.env.MCP_STDIO_COMMANDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((cmd) => {
      const name = `stdio-${Date.now()}`;
      servers.push(new MCPServerStdio({ name, fullCommand: cmd }));
      connected.streamable.push({ name, cmd });
    });

  const a = new Agent({
    name: process.env.AGENT_NAME || "Mapache MCP Bridge",
    instructions:
      process.env.AGENT_INSTRUCTIONS || "Use MCP tools when available.",
    tools,
    mcpServers: servers,
  });

  // Try to connect; do NOT crash if any server is unreachable/misconfigured
  for (const s of servers) {
    try {
      await s.connect();
    } catch (e) {
      console.error("MCP connect error:", s.name, e?.message);
    }
  }

  return a;
}

// Build once on boot
agent = await buildAgent();

// Simple root + health
app.get("/", (_req, res) => {
  res.json({ name: "Mapache MCP Bridge", ok: true });
});
app.get("/healthz", (_req, res) => res.type("text/plain").send("ok"));

// List connected MCP servers
app.get("/tools", (_req, res) => {
  res.json({
    hosted: connected.hosted,
    streamable: connected.streamable,
    count: connected.hosted.length + connected.streamable.length,
  });
});

// Run an instruction through the agent (uses MCP if configured)
app.post("/run", async (req, res) => {
  try {
    if (!agent) agent = await buildAgent();
    const prompt = req.body?.prompt ?? "";
    const result = await run(agent, prompt, { stream: false });
    res.json({
      output: result.finalOutput,
      toolEvents: result.toolEvents ?? [],
      citations: result.citations ?? [],
    });
  } catch (e) {
    console.error("RUN ERROR", e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`MCP bridge listening on :${port}`);
});
