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

// ───────────────────────────────────────────────────────────────
// Linear GraphQL (direct fallback) — avoids LLM ambiguity for writes
// ───────────────────────────────────────────────────────────────
const LINEAR_API_KEY = process.env.LINEAR_API_KEY || "";
const LINEAR_GQL_ENDPOINT = "https://api.linear.app/graphql";

async function linearGql(query, variables = {}) {
  if (!LINEAR_API_KEY) {
    throw new Error("LINEAR_API_KEY not set");
  }

  // Linear expects the API key itself in the Authorization header (no "Bearer ").
  const rawKey = LINEAR_API_KEY || "";
  const authValue = rawKey.replace(/^Bearer\s+/i, "").trim();

  const res = await fetch(LINEAR_GQL_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json",
      "authorization": authValue, // <-- key only, no Bearer prefix
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.errors) {
    throw new Error(
      `Linear GQL error: ${res.status} ${JSON.stringify(json.errors || json)}`
    );
  }
  return json.data;
}

// ───────────────────────────────────────────────────────────────
// MCP agent wiring (unchanged, with hardened connects)
// ───────────────────────────────────────────────────────────────
let agent;
let connected = { hosted: [], streamable: [] };
let servers = [];

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

// ───────────────────────────────────────────────────────────────
// Simple root + health
// ───────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.json({ name: "Mapache MCP Bridge", ok: true });
});
app.get("/healthz", (_req, res) => res.type("text/plain").send("ok"));

// ───────────────────────────────────────────────────────────────
// List connected MCP servers
// ───────────────────────────────────────────────────────────────
app.get("/tools", (_req, res) => {
  res.json({
    hosted: connected.hosted,
    streamable: connected.streamable,
    count: connected.hosted.length + connected.streamable.length,
  });
});

// ───────────────────────────────────────────────────────────────
// Linear (direct) endpoints — deterministic writes with verification
// ───────────────────────────────────────────────────────────────

// Create a comment and verify it persisted
app.post("/linear/commentCreate", async (req, res) => {
  try {
    const { issueId, body, clientMutationId } = req.body || {};
    if (!issueId || !body) {
      return res.status(400).json({ error: "issueId and body are required" });
    }

    const mutation = `
      mutation CommentCreate($input: CommentCreateInput!) {
        commentCreate(input: $input) {
          success
          comment { id body createdAt }
        }
      }
    `;
    const input = {
      issueId,
      body,
    };
    
    // Add clientMutationId only if explicitly provided
    if (clientMutationId) {
      input.clientMutationId = clientMutationId;
    }

    const createRes = await linearGql(mutation, { input });
    const success = !!createRes?.commentCreate?.success;
    const created = createRes?.commentCreate?.comment;

    // Post-write verification: fetch comments and ensure the new one exists
    const verifyQuery = `
      query Verify($id: String!) {
        issue(id: $id) {
          id
          comments(last: 20) { nodes { id body createdAt } }
        }
      }
    `;
    const verify = await linearGql(verifyQuery, { id: issueId });
    const nodes = verify?.issue?.comments?.nodes || [];
    const found = created && nodes.some((n) => n.id === created.id);

    if (!success || !found) {
      return res.status(502).json({
        error: "Comment not persisted",
        success,
        created,
        verifySample: nodes.slice(-3),
      });
    }

    return res.json({ success: true, comment: created });
  } catch (e) {
    console.error("Linear commentCreate failed:", e);
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// List comments on an issue
app.get("/linear/comments", async (req, res) => {
  try {
    const issueId = req.query.issueId;
    if (!issueId)
      return res.status(400).json({ error: "issueId is required" });

    const q = `
      query Q($id: String!) {
        issue(id: $id) {
          id identifier
          comments(last: 50) { nodes { id body createdAt } }
        }
      }
    `;
    const data = await linearGql(q, { id: issueId });
    return res.json({
      issue: data?.issue?.identifier || issueId,
      comments: data?.issue?.comments?.nodes || [],
    });
  } catch (e) {
    console.error("Linear comments fetch failed:", e);
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// ------- Linear: issueCreate (deterministic fallback) -------
app.post('/linear/issueCreate', async (req, res) => {
  try {
    const { teamId, title, description = '', labels = [], priority = 0 } = req.body || {};
    if (!process.env.LINEAR_API_KEY) return res.status(500).json({ error: 'LINEAR_API_KEY missing' });
    if (!teamId || !title) return res.status(400).json({ error: 'teamId and title are required' });

    // 1) resolve backlog workflowStateId for team
    const qStates = `
      query($id: String!) {
        team(id: $id) {
          id
          states {
            nodes { id name type }
          }
        }
      }`;
    const rStates = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': process.env.LINEAR_API_KEY },
      body: JSON.stringify({ query: qStates, variables: { id: teamId } })
    }).then(r => r.json());

    if (rStates.errors) return res.status(400).json({ error: 'Linear states error', details: rStates.errors });
    const states = rStates?.data?.team?.states?.nodes || [];
    const backlog = states.find(s => s.type?.toLowerCase() === 'backlog') || states.find(s => /backlog/i.test(s.name));
    if (!backlog) return res.status(400).json({ error: 'Backlog state not found for team', states });

    // 2) create issue
    const qCreate = `
      mutation IssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier title url }
        }
      }`;
    const input = {
      teamId,
      title,
      description,
      priority,
      stateId: backlog.id,
      labelIds: labels // array of label IDs if you have them; otherwise leave empty
    };
    const rCreate = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': process.env.LINEAR_API_KEY },
      body: JSON.stringify({ query: qCreate, variables: { input } })
    }).then(r => r.json());

    if (rCreate.errors) return res.status(400).json({ error: 'Linear create error', details: rCreate.errors });
    return res.json(rCreate.data.issueCreate);
  } catch (e) {
    console.error('issueCreate error', e);
    return res.status(500).json({ error: 'issueCreate failed', message: String(e) });
  }
});

// ------- Linear: teams (for discovery) -------
app.get('/linear/teams', async (_req, res) => {
  try {
    if (!process.env.LINEAR_API_KEY) return res.status(500).json({ error: 'LINEAR_API_KEY missing' });
    const q = `query { teams(first: 50) { nodes { id key name } } }`;
    const r = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': process.env.LINEAR_API_KEY },
      body: JSON.stringify({ query: q })
    }).then(r => r.json());
    if (r.errors) return res.status(400).json({ error: 'Linear teams error', details: r.errors });
    res.json(r.data.teams.nodes);
  } catch (e) {
    console.error('teams error', e);
    res.status(500).json({ error: 'teams failed', message: String(e) });
  }
});

// ───────────────────────────────────────────────────────────────
// Run an instruction through the agent (uses MCP if configured)
// ───────────────────────────────────────────────────────────────
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
