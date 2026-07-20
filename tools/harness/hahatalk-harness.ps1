param(
  [ValidateSet("feature", "pre-commit", "ci", "docs")]
  [string]$Mode = "feature",
  [string]$Feature = "pc-mvp-shell"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

Write-Host "HahaTalk harness"
Write-Host "Mode: $Mode"
Write-Host "Feature: $Feature"
Write-Host "Root: $root"

$required = @(
  "README.md",
  "docs/mvp-architecture.md",
  "packages/contracts/src/index.ts",
  "apps/web/components/work-desk.tsx",
  "apps/web/components/broadcast-desk.tsx",
  "apps/web/components/remote-support-panel.tsx",
  "apps/api/src/main.ts",
  "apps/api/src/remote-support/remote-support.service.ts",
  "apps/api/src/mobile/mobile.service.ts",
  "apps/api/src/operations/operations.controller.ts",
  "apps/api/migrations/014_mobile_companion.sql",
  "apps/api/migrations/015_release_hardening.sql",
  "apps/api/migrations/016_release_hardening_lifecycle_concurrency.sql",
  "apps/api/migrations/017_local_ai_conversation.sql",
  "apps/mobile/app.config.ts",
  "apps/mobile/src/lib/offline-queue.ts",
  "apps/desktop/main.cjs",
  "apps/desktop/remote-support-agent.cjs"
)

foreach ($path in $required) {
  if (!(Test-Path -LiteralPath $path)) {
    throw "Missing required file: $path"
  }
}

if (!(Test-Path -LiteralPath "node_modules")) {
  throw "node_modules not found. Run npm install first."
}

function Invoke-CheckedCommand {
  param([string[]]$Command)

  $exe = $Command[0]
  $commandArgs = @()
  if ($Command.Length -gt 1) {
    $commandArgs = $Command[1..($Command.Length - 1)]
  }

  & $exe @commandArgs
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed: $($Command -join ' ')"
  }
}

Invoke-CheckedCommand -Command @("npm", "run", "typecheck")
Invoke-CheckedCommand -Command @("npm", "test")
Invoke-CheckedCommand -Command @("npm", "run", "schema:check")
Invoke-CheckedCommand -Command @("npm", "run", "media-infra:check")
Invoke-CheckedCommand -Command @("npm", "run", "desktop:check")
Invoke-CheckedCommand -Command @("npm", "run", "mobile:check")
Invoke-CheckedCommand -Command @("npm", "run", "release:artifact-check")
if ($env:OS -eq "Windows_NT") {
  Invoke-CheckedCommand -Command @("npm", "run", "desktop:remote-agent-process-smoke")
}
Invoke-CheckedCommand -Command @("npm", "run", "build")
Invoke-CheckedCommand -Command @("npm", "run", "mobile:bundle-check")
if ($env:OS -eq "Windows_NT" -and [string]::IsNullOrWhiteSpace($env:DATABASE_URL)) {
  Invoke-CheckedCommand -Command @(
    "powershell",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "tools/dev/portable-postgres.ps1",
    "-Action",
    "Start"
  )
}
Invoke-CheckedCommand -Command @("npm", "run", "auth:integration")
Invoke-CheckedCommand -Command @("npm", "run", "invitation:integration")
Invoke-CheckedCommand -Command @("npm", "run", "conversation:integration")
Invoke-CheckedCommand -Command @("npm", "run", "assistant:integration")
Invoke-CheckedCommand -Command @("npm", "run", "contacts:integration")
Invoke-CheckedCommand -Command @("npm", "run", "media:integration")
Invoke-CheckedCommand -Command @("npm", "run", "calendar:integration")
if ($env:OS -eq "Windows_NT") {
  Invoke-CheckedCommand -Command @("npm", "run", "infra:livekit:portable")
  Invoke-CheckedCommand -Command @("npm", "run", "recording:integration")
  Invoke-CheckedCommand -Command @("npm", "run", "broadcasts:integration")
}
Invoke-CheckedCommand -Command @("npm", "run", "ai:integration")
Invoke-CheckedCommand -Command @("npm", "run", "remote-support:integration")
Invoke-CheckedCommand -Command @("npm", "run", "mobile:integration")
Invoke-CheckedCommand -Command @("npm", "run", "release:integration")
Invoke-CheckedCommand -Command @("npm", "run", "release:load")
Invoke-CheckedCommand -Command @("npm", "run", "smoke")

$verificationDir = Join-Path $root "node_modules\.cache"
$verificationPath = Join-Path $verificationDir "hahatalk-last-verification.json"
New-Item -ItemType Directory -Force -Path $verificationDir | Out-Null
@{
  verifiedAt = (Get-Date).ToUniversalTime().ToString("o")
  mode = $Mode
  feature = $Feature
  branch = (& git branch --show-current).Trim()
  commit = (& git rev-parse --short HEAD).Trim()
} | ConvertTo-Json | Set-Content -LiteralPath $verificationPath -Encoding UTF8

Write-Host "Harness passed."
