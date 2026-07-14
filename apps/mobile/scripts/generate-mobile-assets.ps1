$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$mobileRoot = Split-Path -Parent $PSScriptRoot
$assetsRoot = Join-Path $mobileRoot "assets"
New-Item -ItemType Directory -Force -Path $assetsRoot | Out-Null

function New-HahaTalkBitmap {
  param(
    [int]$Size,
    [bool]$Transparent,
    [double]$Scale = 0.72
  )

  $bitmap = New-Object System.Drawing.Bitmap $Size, $Size
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear($(if ($Transparent) { [System.Drawing.Color]::Transparent } else { [System.Drawing.Color]::FromArgb(255, 15, 159, 143) }))

  $box = [int]($Size * $Scale)
  $offset = [int](($Size - $box) / 2)
  $radius = [int]($box * 0.2)
  $diameter = $radius * 2
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc($offset, $offset, $diameter, $diameter, 180, 90)
  $path.AddArc($offset + $box - $diameter, $offset, $diameter, $diameter, 270, 90)
  $path.AddArc($offset + $box - $diameter, $offset + $box - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($offset, $offset + $box - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()

  if ($Transparent) {
    $background = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 15, 159, 143))
    $graphics.FillPath($background, $path)
    $background.Dispose()
  }

  $font = New-Object System.Drawing.Font "Segoe UI", ([int]($box * 0.54)), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $foreground = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = [System.Drawing.StringAlignment]::Center
  $format.LineAlignment = [System.Drawing.StringAlignment]::Center
  $graphics.DrawString("H", $font, $foreground, (New-Object System.Drawing.RectangleF $offset, ($offset - [int]($box * 0.035)), $box, $box), $format)

  $format.Dispose()
  $foreground.Dispose()
  $font.Dispose()
  $path.Dispose()
  $graphics.Dispose()
  return $bitmap
}

$appIcon = New-HahaTalkBitmap -Size 1024 -Transparent $false -Scale 0.82
$appIcon.Save((Join-Path $assetsRoot "app-icon.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$appIcon.Dispose()

$adaptiveIcon = New-HahaTalkBitmap -Size 1024 -Transparent $true -Scale 0.54
$adaptiveIcon.Save((Join-Path $assetsRoot "adaptive-icon.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$adaptiveIcon.Dispose()

$splashIcon = New-HahaTalkBitmap -Size 512 -Transparent $true -Scale 0.7
$splashIcon.Save((Join-Path $assetsRoot "splash-icon.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$splashIcon.Dispose()

$notification = New-HahaTalkBitmap -Size 96 -Transparent $true -Scale 0.72
$notification.Save((Join-Path $assetsRoot "notification-icon.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$notification.Dispose()

Write-Host "Generated HahaTalk mobile assets in $assetsRoot"
