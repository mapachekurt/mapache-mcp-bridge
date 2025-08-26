param([Parameter(Mandatory=$true)][string]$Base, [string]$Issue="")

Write-Host "Health:" -f Cyan
Invoke-RestMethod "$Base/healthz" | Out-String

Write-Host "`nTools:" -f Cyan
Invoke-RestMethod "$Base/tools" | ConvertTo-Json -Depth 5

Write-Host "`nRun:" -f Cyan
$body = @{ prompt = "Say 'bridge online'." } | ConvertTo-Json -Depth 4
Invoke-RestMethod -Method Post -Uri "$Base/run" -ContentType "application/json" -Body $body

if ($Issue) {
  Write-Host "`nCreate comment:" -f Cyan
  $create = @{ issueId=$Issue; body="Bridge created this via MCP." } | ConvertTo-Json -Depth 4
  Invoke-RestMethod -Method Post -Uri "$Base/linear/commentCreate" -ContentType "application/json" -Body $create

  Write-Host "`nVerify comments:" -f Cyan
  Invoke-RestMethod "$Base/linear/comments?issueId=$Issue" | ConvertTo-Json -Depth 5
}
