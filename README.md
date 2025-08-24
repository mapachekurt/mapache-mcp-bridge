# mapache-mcp-bridge
OpenAI Agents SDK MCP Bridge API for ChatGPT Custom GPT Actions

## Deploy (Railway GUI)
1. New Project → Deploy from Repo → pick this repo.
2. Add Environment Variables from `.env.example`.
3. Deploy. Copy the public URL (e.g., https://mapache-bridge.up.railway.app). Confirm `/healthz`.

## Add to ChatGPT as a Custom GPT Action
1. Go to [chatgpt.com/gpts/editor](https://chatgpt.com/gpts/editor) (Plus/Team/Enterprise).  
2. Tab **Configure** → **Actions** → *Add Action* → **Import from OpenAPI** → paste the OpenAPI URL: `https://raw.githubusercontent.com/mapachekurt/mapache-mcp-bridge/main/openapi.yaml`
3. In **Instructions**, paste the suggested GPT instructions below. Save the GPT.

### Suggested GPT Instructions
