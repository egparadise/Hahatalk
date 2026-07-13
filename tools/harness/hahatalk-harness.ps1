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
  "apps/api/src/main.ts",
  "apps/desktop/main.cjs"
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
Invoke-CheckedCommand -Command @("npm", "run", "desktop:check")
Invoke-CheckedCommand -Command @("npm", "run", "build")
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
Invoke-CheckedCommand -Command @("npm", "run", "contacts:integration")
Invoke-CheckedCommand -Command @("npm", "run", "media:integration")
Invoke-CheckedCommand -Command @("npm", "run", "calendar:integration")
if ($env:OS -eq "Windows_NT") {
  Invoke-CheckedCommand -Command @("npm", "run", "infra:livekit:portable")
  Invoke-CheckedCommand -Command @("npm", "run", "screen-share:integration")
}
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
