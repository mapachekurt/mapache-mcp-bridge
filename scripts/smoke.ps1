# Set once per session
$env:APP = "https://mapache-mcp-bridge-production.up.railway.app"
Write-Host "APP = $env:APP"

# 1) Health
iwr "$env:APP/healthz" | % Content

# 2) Tools (should show 'linear' under hosted)
iwr "$env:APP/tools" | % Content

# 3) /run smoke: nudge agent to use Linear MCP
$body = @{ prompt = "List my Linear teams (names + IDs). If auth is needed, follow the hosted MCP flow." } | ConvertTo-Json -Depth 4
irm -Method Post -Uri "$env:APP/run" -ContentType "application/json" -Body $body

# 4) (optional) deterministic fallback create:
# $teamId = "<YOUR_LINEAR_TEAM_ID>"
# $payload = @{ teamId=$teamId; title="Chat cleanup → backlog"; description="Created by bridge." } | ConvertTo-Json -Depth 5
# irm -Method Post -Uri "$env:APP/linear/issueCreate" -ContentType "application/json" -Body $payload
