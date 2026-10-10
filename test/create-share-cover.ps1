Add-Type -AssemblyName System.Drawing
$cover = New-Object System.Drawing.Bitmap 1000,800
$canvas = [System.Drawing.Graphics]::FromImage($cover)
$canvas.SmoothingMode = 'AntiAlias'
$canvas.TextRenderingHint = 'AntiAliasGridFit'
$canvas.Clear([System.Drawing.ColorTranslator]::FromHtml('#FFF8F6'))
$ink = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#493C40'))
$pink = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#FF6B81'))
$paper = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$line = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#E9ADB8')),4
$headline = New-Object System.Drawing.Font 'Microsoft YaHei',42,([System.Drawing.FontStyle]::Bold)
$body = New-Object System.Drawing.Font 'Microsoft YaHei',23
$canvas.DrawString('交换这一期的心意', $headline, $ink, 100, 85)
$canvas.DrawString('留一点时间，听听彼此的感受', $body, $ink, 105, 175)
$canvas.FillRectangle($paper,180,300,640,310)
$canvas.DrawRectangle($line,180,300,640,310)
$canvas.DrawLine($line,180,300,500,485)
$canvas.DrawLine($line,820,300,500,485)
$canvas.FillEllipse($pink,454,434,92,92)
$canvas.DrawString('恋恋温度计', $body, $ink, 390, 670)
$cover.Save((Join-Path $PSScriptRoot '../miniprogram/images/exchange-share.png'),[System.Drawing.Imaging.ImageFormat]::Png)
$canvas.Dispose()
$cover.Dispose()
foreach ($resource in @($ink,$pink,$paper,$line,$headline,$body)) { $resource.Dispose() }
