$ErrorActionPreference = "Stop"

$repoRoot = (& git rev-parse --show-toplevel 2>$null).Trim()
if ([string]::IsNullOrWhiteSpace($repoRoot)) {
  exit 0
}

$obsidianRoot = "C:\Users\egpar\OneDrive - Inviz\15.Vibe Cording\Obsidian\hahtalk\HahaTalk"
$reportDir = Join-Path $obsidianRoot "90_Reports"
$latestReport = Get-ChildItem -LiteralPath $reportDir -Filter "*.md" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTimeUtc -Descending |
  Select-Object -First 1

$reportPath = if ($latestReport) { $latestReport.FullName } else { "none" }

Write-Output "HahaTalk context: code=$repoRoot; obsidian=$obsidianRoot; latest_report=$reportPath. Use the repo AGENTS.md and `$hahatalk-feature-stage. Before implementation, research current primary sources, create or update an Obsidian report, preserve hub participant privacy, run the harness, then record commit and push results."
