# Generate tabBar icons (81x81 PNG) for the mini program.
Add-Type -AssemblyName System.Drawing
$dir = Join-Path $PSScriptRoot '..\miniprogram\images'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

function RoundedPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc($x, $y, 2*$r, 2*$r, 180, 90)
  $p.AddArc($x+$w-2*$r, $y, 2*$r, 2*$r, 270, 90)
  $p.AddArc($x+$w-2*$r, $y+$h-2*$r, 2*$r, 2*$r, 0, 90)
  $p.AddArc($x, $y+$h-2*$r, 2*$r, 2*$r, 90, 90)
  $p.CloseFigure()
  return $p
}

function MakeIcon([string]$file, [string]$hex, [string]$kind) {
  $bmp = New-Object System.Drawing.Bitmap -ArgumentList 81, 81
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $col = [System.Drawing.ColorTranslator]::FromHtml($hex)
  $b = New-Object System.Drawing.SolidBrush -ArgumentList $col
  $w = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::White)
  switch ($kind) {
    'home' {
      $g.FillEllipse($b, 12, 14, 28, 28)
      $g.FillEllipse($b, 41, 14, 28, 28)
      $pts = @(
        (New-Object System.Drawing.PointF -ArgumentList 14, 38),
        (New-Object System.Drawing.PointF -ArgumentList 67, 38),
        (New-Object System.Drawing.PointF -ArgumentList 40.5, 67)
      )
      $g.FillPolygon($b, $pts)
    }
    'note' {
      $path = RoundedPath 16 10 49 61 8
      $g.FillPath($b, $path)
      $g.FillRectangle($w, 25, 24, 31, 5)
      $g.FillRectangle($w, 25, 37, 31, 5)
      $g.FillRectangle($w, 25, 50, 20, 5)
    }
    'chart' {
      $p1 = RoundedPath 13 42 15 27 3; $g.FillPath($b, $p1)
      $p2 = RoundedPath 33 26 15 43 3; $g.FillPath($b, $p2)
      $p3 = RoundedPath 53 14 15 55 3; $g.FillPath($b, $p3)
    }
    'set' {
      $g.FillRectangle($b, 33, 6, 15, 15)
      $g.FillRectangle($b, 33, 60, 15, 15)
      $g.FillRectangle($b, 6, 33, 15, 15)
      $g.FillRectangle($b, 60, 33, 15, 15)
      $g.FillEllipse($b, 15, 15, 51, 51)
      $g.FillEllipse($w, 30, 30, 21, 21)
    }
  }
  $g.Dispose()
  $bmp.Save((Join-Path $dir $file), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

MakeIcon 'tab-home.png'  '#C8C0BC' 'home'
MakeIcon 'tab-home-on.png'  '#FF6B81' 'home'
MakeIcon 'tab-note.png'  '#C8C0BC' 'note'
MakeIcon 'tab-note-on.png'  '#FF6B81' 'note'
MakeIcon 'tab-chart.png' '#C8C0BC' 'chart'
MakeIcon 'tab-chart-on.png' '#FF6B81' 'chart'
MakeIcon 'tab-set.png'   '#C8C0BC' 'set'
MakeIcon 'tab-set-on.png'   '#FF6B81' 'set'
Write-Host 'OK icons generated'
