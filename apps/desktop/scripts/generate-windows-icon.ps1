$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$desktopRoot = Split-Path -Parent $PSScriptRoot
$assetsRoot = Join-Path $desktopRoot "assets"
$iconPath = Join-Path $assetsRoot "hahatalk.ico"
New-Item -ItemType Directory -Force -Path $assetsRoot | Out-Null

$bitmap = New-Object System.Drawing.Bitmap 256, 256
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::Transparent)

$background = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 15, 159, 143))
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$radius = 48
$diameter = $radius * 2
$path.AddArc(0, 0, $diameter, $diameter, 180, 90)
$path.AddArc(256 - $diameter, 0, $diameter, $diameter, 270, 90)
$path.AddArc(256 - $diameter, 256 - $diameter, $diameter, $diameter, 0, 90)
$path.AddArc(0, 256 - $diameter, $diameter, $diameter, 90, 90)
$path.CloseFigure()
$graphics.FillPath($background, $path)

$font = New-Object System.Drawing.Font "Segoe UI", 132, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$foreground = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$format = New-Object System.Drawing.StringFormat
$format.Alignment = [System.Drawing.StringAlignment]::Center
$format.LineAlignment = [System.Drawing.StringAlignment]::Center
$graphics.DrawString("H", $font, $foreground, (New-Object System.Drawing.RectangleF 0, 0, 256, 244), $format)

$pngStream = New-Object System.IO.MemoryStream
$bitmap.Save($pngStream, [System.Drawing.Imaging.ImageFormat]::Png)
$pngBytes = $pngStream.ToArray()
$fileStream = [System.IO.File]::Create($iconPath)
$writer = New-Object System.IO.BinaryWriter $fileStream
$writer.Write([UInt16]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]1)
$writer.Write([Byte]0)
$writer.Write([Byte]0)
$writer.Write([Byte]0)
$writer.Write([Byte]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]32)
$writer.Write([UInt32]$pngBytes.Length)
$writer.Write([UInt32]22)
$writer.Write($pngBytes)
$writer.Dispose()

$pngStream.Dispose()
$format.Dispose()
$foreground.Dispose()
$font.Dispose()
$path.Dispose()
$background.Dispose()
$graphics.Dispose()
$bitmap.Dispose()

Write-Host "Generated $iconPath"
