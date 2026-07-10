$ErrorActionPreference = "Stop"

$repoRoot = (& git rev-parse --show-toplevel 2>$null).Trim()
if ([string]::IsNullOrWhiteSpace($repoRoot)) {
  Write-Output '{"continue":true}'
  exit 0
}

Set-Location $repoRoot
$status = (& git status --porcelain | Out-String).Trim()
$verificationPath = Join-Path $repoRoot "node_modules\.cache\hahatalk-last-verification.json"

if (![string]::IsNullOrWhiteSpace($status) -and !(Test-Path -LiteralPath $verificationPath)) {
  @{
    continue = $true
    systemMessage = "HahaTalk source changes are present without a recorded harness pass. Run npm run harness and update the current Obsidian report before declaring the stage complete."
  } | ConvertTo-Json -Compress
  exit 0
}

Write-Output '{"continue":true}'
