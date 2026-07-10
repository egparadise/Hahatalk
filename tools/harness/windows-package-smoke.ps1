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
  try {
    $status = Wait-RuntimeStatus -ExpectedPid $process.Id -StartedAt $startedAt
    return @{ Process = $process; Status = $status }
  }
  catch {
    & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null
    throw
  }
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

function New-AuthenticatedSession {
  param(
    [string]$ApiUrl,
    [string]$WebOrigin,
    [string]$DisplayName,
    [string]$Email,
    [string]$CharacterId
  )

  $password = if ($env:HAHATALK_SMOKE_PASSWORD) { $env:HAHATALK_SMOKE_PASSWORD } else { "HahaTalk!Stage2" }
  $headers = @{
    Origin = $WebOrigin
    "X-HahaTalk-Client" = "web-v1"
  }
  $signupBody = @{
    characterId = $CharacterId
    displayName = $DisplayName
    email = $Email
    password = $password
  } | ConvertTo-Json

  try {
    Invoke-RestMethod -Method Post -Uri "$ApiUrl/auth/signup" -Headers $headers -ContentType "application/json" -Body $signupBody -SessionVariable authenticatedSession | Out-Null
  }
  catch {
    if ([int]$_.Exception.Response.StatusCode -ne 409) { throw }
    $loginBody = @{ email = $Email; password = $password } | ConvertTo-Json
    Invoke-RestMethod -Method Post -Uri "$ApiUrl/auth/login" -Headers $headers -ContentType "application/json" -Body $loginBody -SessionVariable authenticatedSession | Out-Null
  }

  return $authenticatedSession
}

if (Get-LiveStatus) {
  throw "A HahaTalk runtime is already active. Close it before running the package smoke test."
}

$run = Start-HahaTalk
$status = $run.Status
$health = Invoke-RestMethod -Uri "$($status.apiUrl)/health"
$ownerSession = New-AuthenticatedSession -ApiUrl $status.apiUrl -WebOrigin $status.webUrl -DisplayName "HahaTalk Owner" -Email "you@inviz.co.kr" -CharacterId "char-calm-lead"
$participantSession = New-AuthenticatedSession -ApiUrl $status.apiUrl -WebOrigin $status.webUrl -DisplayName "Mina Kim" -Email "mina@inviz.co.kr" -CharacterId "char-focus-maker"
$owner = Invoke-RestMethod -Uri "$($status.apiUrl)/mvp" -WebSession $ownerSession
$participant = Invoke-RestMethod -Uri "$($status.apiUrl)/mvp?viewerId=user-you" -WebSession $participantSession

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
