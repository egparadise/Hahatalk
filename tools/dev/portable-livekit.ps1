param(
  [string]$Version = "1.13.3"
)

$ErrorActionPreference = "Stop"
$developmentRoot = Join-Path $env:LOCALAPPDATA "HahaTalkDev\LiveKit"
$versionRoot = Join-Path $developmentRoot $Version
$downloadRoot = Join-Path $developmentRoot "downloads"
$archiveName = "livekit_$($Version)_windows_amd64.zip"
$archivePath = Join-Path $downloadRoot $archiveName
$downloadUrl = "https://github.com/livekit/livekit/releases/download/v$Version/$archiveName"
$expectedSha256 = if ($Version -eq "1.13.3") {
  "d29786e63a11de390fb8051191a30520cfb687d8f6cb5063b6ef0f748f029727"
} else {
  throw "No audited LiveKit checksum is registered for version $Version."
}

New-Item -ItemType Directory -Force -Path $developmentRoot, $downloadRoot | Out-Null
$resolvedDevelopmentRoot = [System.IO.Path]::GetFullPath($developmentRoot)
$resolvedVersionRoot = [System.IO.Path]::GetFullPath($versionRoot)
if (!$resolvedVersionRoot.StartsWith($resolvedDevelopmentRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "LiveKit extraction path escaped the HahaTalk development cache."
}

if (!(Test-Path -LiteralPath $archivePath) -or (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant() -ne $expectedSha256) {
  Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile $archivePath
}
$actualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
if ($actualSha256 -ne $expectedSha256) {
  throw "LiveKit archive checksum mismatch. Expected $expectedSha256, received $actualSha256."
}

$existing = Get-ChildItem -LiteralPath $versionRoot -Filter "livekit-server.exe" -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if (!$existing) {
  if (Test-Path -LiteralPath $versionRoot) {
    Remove-Item -LiteralPath $versionRoot -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $versionRoot | Out-Null
  Expand-Archive -LiteralPath $archivePath -DestinationPath $versionRoot -Force
  $existing = Get-ChildItem -LiteralPath $versionRoot -Filter "livekit-server.exe" -File -Recurse | Select-Object -First 1
}
if (!$existing) {
  throw "The LiveKit Windows server executable was not found after extraction."
}

Write-Output $existing.FullName
