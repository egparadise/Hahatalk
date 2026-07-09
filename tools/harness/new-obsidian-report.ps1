param(
  [Parameter(Mandatory = $true)]
  [string]$Feature,
  [string]$Goal = "",
  [string]$ObsidianRoot = "C:\Users\egpar\OneDrive - Inviz\15.Vibe Cording\Obsidian\hahtalk\HahaTalk"
)

$ErrorActionPreference = "Stop"

function ConvertTo-SafeSlug {
  param([string]$Value)

  $slug = $Value.ToLowerInvariant() -replace '[^\p{L}\p{Nd}]+', '-' -replace '(^-+|-+$)', ''
  if ([string]::IsNullOrWhiteSpace($slug)) {
    return "development-session"
  }

  return $slug
}

function Invoke-ReportWriteWithRetry {
  param([scriptblock]$Operation)

  for ($attempt = 1; $attempt -le 20; $attempt++) {
    try {
      & $Operation
      return
    }
    catch {
      if ($attempt -eq 20) {
        throw
      }

      Start-Sleep -Milliseconds (100 * $attempt)
    }
  }
}

$codeRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm"
$safeFeature = ConvertTo-SafeSlug -Value $Feature
$reportDir = Join-Path $ObsidianRoot "90_Reports"
$reportPath = Join-Path $reportDir ("{0}_{1}.md" -f $timestamp, $safeFeature)

New-Item -ItemType Directory -Force -Path $reportDir | Out-Null

if (Test-Path -LiteralPath $reportPath) {
  Write-Host "Report already exists: $reportPath"
  exit 0
}

$content = @"
# $timestamp - $Feature

## Goal

$Goal

## Canonical Paths

- Code root: `$codeRoot`
- Obsidian root: `$ObsidianRoot`
- Git remote: `https://github.com/egparadise/Hahatalk.git`

## Files Changed

## Commands Run

## Verification Result

## Errors Found

## Fixes Applied

## Decisions

## Git Result

## Remaining Risks

## Next Step
"@

Invoke-ReportWriteWithRetry -Operation {
  Set-Content -LiteralPath $reportPath -Value $content -Encoding UTF8
}
Write-Host "Created report: $reportPath"
