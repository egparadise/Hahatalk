param(
  [string]$ExecutablePath = "apps\desktop\out\HahaTalk-win32-x64\HahaTalk.exe",
  [switch]$LeaveRunning
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

$resolvedExecutable = (Resolve-Path -LiteralPath $ExecutablePath).Path
$statusPath = Join-Path $env:APPDATA "HahaTalk\runtime-status.json"

function Get-LiveStatus {
  if (!(Test-Path -LiteralPath $statusPath)) { return $null }
  $status = Get-Content -Raw -Encoding utf8 $statusPath | ConvertFrom-Json
  if (Get-Process -Id $status.pid -ErrorAction SilentlyContinue) { return $status }
  return $null
}

function Wait-RuntimeStatus {
  param([int]$ExpectedPid, [datetime]$StartedAt)

  $deadline = (Get-Date).AddSeconds(30)
  do {
    Start-Sleep -Milliseconds 300
    if (Test-Path -LiteralPath $statusPath) {
      $statusFile = Get-Item -LiteralPath $statusPath
      if ($statusFile.LastWriteTime -ge $StartedAt) {
        $status = Get-Content -Raw -Encoding utf8 $statusPath | ConvertFrom-Json
        if ($status.pid -eq $ExpectedPid -and $status.rendererReady -eq $true) { return $status }
      }
    }
  } until ((Get-Date) -gt $deadline)

  throw "HahaTalk runtime status did not become ready."
}

function Start-HahaTalk {
  $startedAt = Get-Date
  $process = Start-Process -FilePath $resolvedExecutable -PassThru
  $status = Wait-RuntimeStatus -ExpectedPid $process.Id -StartedAt $startedAt
  return @{ Process = $process; Status = $status }
}

function Stop-HahaTalk {
  param($Status)

  $apiUrl = $Status.apiUrl
  $process = Get-Process -Id $Status.pid -ErrorAction SilentlyContinue
  if ($process) { $process.CloseMainWindow() | Out-Null }
  $deadline = (Get-Date).AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 250
    $process = Get-Process -Id $Status.pid -ErrorAction SilentlyContinue
  } until (!$process -or (Get-Date) -gt $deadline)

  if ($process) { throw "HahaTalk did not exit after closing its main window." }
  Start-Sleep -Milliseconds 500
  if (Test-Path -LiteralPath $statusPath) { throw "HahaTalk runtime status was not removed." }

  try {
    Invoke-RestMethod -Uri "$apiUrl/health" -TimeoutSec 1 | Out-Null
    throw "HahaTalk API remained reachable after shutdown."
  } catch {
    if ($_.Exception.Message -eq "HahaTalk API remained reachable after shutdown.") { throw }
  }
}

if (Get-LiveStatus) {
  throw "A HahaTalk runtime is already active. Close it before running the package smoke test."
}

$run = Start-HahaTalk
$status = $run.Status
$health = Invoke-RestMethod -Uri "$($status.apiUrl)/health"
$owner = Invoke-RestMethod -Uri "$($status.apiUrl)/mvp?viewerId=user-you"
$participant = Invoke-RestMethod -Uri "$($status.apiUrl)/mvp?viewerId=user-mina"

if (!$status.packaged -or !$status.rendererApiHealthy -or !$health.ok) { throw "Packaged runtime health verification failed." }
if ($owner.room.mode -ne "hub_owner" -or @($owner.users).Count -ne 4) { throw "Owner projection verification failed." }
if ($participant.room.mode -ne "direct" -or @($participant.users).Count -ne 2) { throw "Participant projection verification failed." }

$second = Start-Process -FilePath $resolvedExecutable -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2
$second.Refresh()
if (!$second.HasExited) { throw "Second HahaTalk process did not exit." }
$primaryProcess = Get-Process -Id $status.pid -ErrorAction SilentlyContinue
$liveStatus = Get-LiveStatus
if (!$primaryProcess -or !$liveStatus -or $liveStatus.pid -ne $status.pid) {
  throw "Primary HahaTalk runtime was not preserved after the second launch."
}

Stop-HahaTalk -Status $status

$finalStatus = $null
if ($LeaveRunning) {
  $finalRun = Start-HahaTalk
  $finalStatus = $finalRun.Status
}

[pscustomobject]@{
  Executable = $resolvedExecutable
  Version = $status.version
  RendererReady = $status.rendererReady
  ApiHealthy = $health.ok
  OwnerUsers = @($owner.users).Count
  ParticipantUsers = @($participant.users).Count
  SingleInstance = $true
  CleanShutdown = $true
  LeftRunning = [bool]$LeaveRunning
  FinalProcessId = if ($finalStatus) { $finalStatus.pid } else { $null }
} | Format-List
