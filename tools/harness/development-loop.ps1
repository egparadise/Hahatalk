param(
  [Parameter(Mandatory = $true)]
  [string]$Feature,
  [ValidateSet("feature", "pre-commit", "ci", "docs")]
  [string]$Mode = "pre-commit",
  [string]$CommitMessage = "",
  [switch]$Commit,
  [switch]$Push,
  [string]$ObsidianRoot = "C:\Users\egpar\OneDrive - Inviz\15.Vibe Cording\Obsidian\hahtalk\HahaTalk",
  [string]$RemoteUrl = "https://github.com/egparadise/Hahatalk.git"
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

function Add-ReportSection {
  param(
    [string]$Title,
    [string[]]$Lines
  )

  Add-ReportLine -Value ""
  Add-ReportLine -Value "## $Title"
  Add-ReportLine -Value ""
  foreach ($line in $Lines) {
    Add-ReportLine -Value $line
  }
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

function Set-ReportContent {
  param([string]$Value)

  Invoke-ReportWriteWithRetry -Operation {
    Set-Content -LiteralPath $script:ReportPath -Encoding UTF8 -Value $Value
  }
}

function Add-ReportLine {
  param([string]$Value)

  Invoke-ReportWriteWithRetry -Operation {
    Add-Content -LiteralPath $script:ReportPath -Encoding UTF8 -Value $Value
  }
}

function Invoke-LoggedCommand {
  param(
    [string]$Label,
    [string]$Executable,
    [string[]]$Arguments
  )

  $commandText = "$Executable $($Arguments -join ' ')"
  Add-ReportSection -Title "Command: $Label" -Lines @("````powershell", $commandText, "````")

  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & $Executable @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  $trimmedOutput = ($output | Select-Object -Last 80) -join [Environment]::NewLine

  Add-ReportSection -Title "Result: $Label" -Lines @(
    "- Exit code: $exitCode",
    "````text",
    $trimmedOutput,
    "````"
  )

  if ($exitCode -ne 0) {
    throw "$Label failed with exit code $exitCode"
  }

  return $output
}

$codeRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $codeRoot

$timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm"
$safeFeature = ConvertTo-SafeSlug -Value $Feature
$reportDir = Join-Path $ObsidianRoot "90_Reports"
$script:ReportPath = Join-Path $reportDir ("{0}_{1}.md" -f $timestamp, $safeFeature)

New-Item -ItemType Directory -Force -Path $reportDir | Out-Null

$header = @"
# $timestamp - $Feature

## Goal

Managed development loop for $Feature.

## Canonical Paths

- Code root: $codeRoot
- Obsidian root: $ObsidianRoot
- Git remote: $RemoteUrl

"@

Set-ReportContent -Value $header

if (!(Test-Path -LiteralPath ".git")) {
  Invoke-LoggedCommand -Label "git init" -Executable "git" -Arguments @("init")
  Invoke-LoggedCommand -Label "git branch main" -Executable "git" -Arguments @("branch", "-M", "main")
}

$originUrl = ""
$remoteNames = & git remote
if ($remoteNames -contains "origin") {
  $originOutput = & git remote get-url origin
  if ($LASTEXITCODE -eq 0) {
    $originUrl = ($originOutput | Select-Object -First 1)
  }
}

if ([string]::IsNullOrWhiteSpace($originUrl)) {
  Invoke-LoggedCommand -Label "git remote add origin" -Executable "git" -Arguments @("remote", "add", "origin", $RemoteUrl)
}
elseif ($originUrl -ne $RemoteUrl) {
  Invoke-LoggedCommand -Label "git remote set-url origin" -Executable "git" -Arguments @("remote", "set-url", "origin", $RemoteUrl)
}

$statusBefore = & git status --short
Add-ReportSection -Title "Git Status Before Verification" -Lines @("````text", (($statusBefore | Out-String).Trim()), "````")

Invoke-LoggedCommand -Label "HahaTalk harness" -Executable "powershell" -Arguments @(
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  "tools\harness\hahatalk-harness.ps1",
  "-Mode",
  $Mode,
  "-Feature",
  $Feature
)

Add-ReportSection -Title "Verification Result" -Lines @("- Harness passed in $Mode mode.")

if ($Commit) {
  if ([string]::IsNullOrWhiteSpace($CommitMessage)) {
    $CommitMessage = "Implement $Feature"
  }

  Invoke-LoggedCommand -Label "git add" -Executable "git" -Arguments @("add", "-A")
  $staged = & git status --short
  Add-ReportSection -Title "Staged Files" -Lines @("````text", (($staged | Out-String).Trim()), "````")

  if ([string]::IsNullOrWhiteSpace((($staged | Out-String).Trim()))) {
    Add-ReportSection -Title "Commit Result" -Lines @("- No changes to commit.")
  }
  else {
    Invoke-LoggedCommand -Label "git commit" -Executable "git" -Arguments @("commit", "-m", $CommitMessage)
    $branch = (& git branch --show-current).Trim()
    $commitHash = (& git rev-parse --short HEAD).Trim()
    Add-ReportSection -Title "Commit Result" -Lines @(
      "- Branch: $branch",
      "- Commit: $commitHash",
      "- Message: $CommitMessage"
    )

    if ($Push) {
      Invoke-LoggedCommand -Label "git push" -Executable "git" -Arguments @("push", "-u", "origin", $branch)
      Add-ReportSection -Title "Push Result" -Lines @(
        "- Branch: $branch",
        "- Remote: $RemoteUrl",
        "- Result: push completed."
      )
    }
  }
}
else {
  Add-ReportSection -Title "Git Result" -Lines @("- Commit was skipped because -Commit was not provided.")
}

Add-ReportSection -Title "Next Step" -Lines @("- Continue with the next smallest HahaTalk feature slice.")

Write-Host "Development loop completed."
Write-Host "Report: $script:ReportPath"
