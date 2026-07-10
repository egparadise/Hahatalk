param(
  [ValidateSet("Start", "Stop", "Status")]
  [string]$Action = "Start",
  [int]$Port = 54329,
  [string]$DatabaseName = "hahatalk",
  [string]$DatabaseUser = "hahatalk",
  [string]$DatabasePassword = "hahatalk_dev_only"
)

$ErrorActionPreference = "Stop"
$version = "18.4-2"
$archiveName = "postgresql-$version-windows-x64-binaries.zip"
$archiveSha256 = "02E239529ED7833D169F98D915D3FEFFE0813264B08B3AE353E78E8B9C97E1A6"
$downloadUrl = "https://get.enterprisedb.com/postgresql/$archiveName"
$developmentRoot = Join-Path $env:LOCALAPPDATA "HahaTalkDev\PostgreSQL"
$downloadDirectory = Join-Path $env:LOCALAPPDATA "HahaTalkDev\downloads"
$archivePath = Join-Path $downloadDirectory $archiveName
$installationRoot = Join-Path $developmentRoot "18.4"
$postgresRoot = Join-Path $installationRoot "pgsql"
$binaryDirectory = Join-Path $postgresRoot "bin"
$dataDirectory = Join-Path $developmentRoot "data"
$logPath = Join-Path $developmentRoot "postgresql.log"
$pgCtl = Join-Path $binaryDirectory "pg_ctl.exe"

if ($DatabaseName -notmatch '^[A-Za-z][A-Za-z0-9_]*$' -or $DatabaseUser -notmatch '^[A-Za-z][A-Za-z0-9_]*$') {
  throw "DatabaseName and DatabaseUser must be simple PostgreSQL identifiers."
}

function Get-ServerStatus {
  if (!(Test-Path -LiteralPath $pgCtl) -or !(Test-Path -LiteralPath (Join-Path $dataDirectory "PG_VERSION"))) {
    return $false
  }
  & $pgCtl -D $dataDirectory status 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { return $false }
  & (Join-Path $binaryDirectory "pg_isready.exe") -h 127.0.0.1 -p $Port -d postgres 2>$null | Out-Null
  return $LASTEXITCODE -eq 0
}

if ($Action -eq "Status") {
  [pscustomobject]@{
    Installed = Test-Path -LiteralPath $pgCtl
    Running = Get-ServerStatus
    Port = $Port
    DataDirectory = $dataDirectory
  } | Format-List
  exit 0
}

if ($Action -eq "Stop") {
  if (Get-ServerStatus) {
    & $pgCtl -D $dataDirectory -w stop
    if ($LASTEXITCODE -ne 0) { throw "Portable PostgreSQL failed to stop." }
  }
  Write-Host "HahaTalk portable PostgreSQL is stopped."
  exit 0
}

if (!(Test-Path -LiteralPath $pgCtl)) {
  New-Item -ItemType Directory -Force -Path $downloadDirectory | Out-Null
  if (!(Test-Path -LiteralPath $archivePath)) {
    Write-Host "Downloading PostgreSQL $version from the EDB binary link published by postgresql.org."
    & curl.exe -L --fail --retry 3 --output $archivePath $downloadUrl
    if ($LASTEXITCODE -ne 0) { throw "PostgreSQL archive download failed." }
  }

  $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash
  if ($actualHash -ne $archiveSha256) {
    throw "PostgreSQL archive checksum mismatch. Expected $archiveSha256, received $actualHash."
  }

  New-Item -ItemType Directory -Force -Path $installationRoot | Out-Null
  Expand-Archive -LiteralPath $archivePath -DestinationPath $installationRoot -Force
}

if (!(Test-Path -LiteralPath (Join-Path $dataDirectory "PG_VERSION"))) {
  New-Item -ItemType Directory -Force -Path $dataDirectory | Out-Null
  $passwordFile = Join-Path $env:TEMP "hahatalk-postgres-init-$PID.pw"
  Set-Content -LiteralPath $passwordFile -Value $DatabasePassword -NoNewline -Encoding ASCII
  try {
    & (Join-Path $binaryDirectory "initdb.exe") -D $dataDirectory -U $DatabaseUser "--pwfile=$passwordFile" `
      "--auth-host=scram-sha-256" "--auth-local=scram-sha-256" -E UTF8 "--locale=C"
    if ($LASTEXITCODE -ne 0) { throw "PostgreSQL initdb failed." }
  }
  finally {
    Remove-Item -LiteralPath $passwordFile -Force -ErrorAction SilentlyContinue
  }
}

if (!(Get-ServerStatus)) {
  & $pgCtl -D $dataDirectory -l $logPath -o "`"-p`" `"$Port`" `"-h`" `"127.0.0.1`"" -w start
  if ($LASTEXITCODE -ne 0) { throw "Portable PostgreSQL failed to start." }
}

$env:PGPASSWORD = $DatabasePassword
try {
  $databaseExists = @(
    & (Join-Path $binaryDirectory "psql.exe") -h 127.0.0.1 -p $Port -U $DatabaseUser -d postgres -tAc `
      "select 1 from pg_database where datname = '$DatabaseName'"
  ) -contains "1"
  if (!$databaseExists) {
    & (Join-Path $binaryDirectory "createdb.exe") -h 127.0.0.1 -p $Port -U $DatabaseUser $DatabaseName
    if ($LASTEXITCODE -ne 0) { throw "HahaTalk database creation failed." }
  }
}
finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}

Write-Host "HahaTalk portable PostgreSQL is ready on 127.0.0.1:$Port."
