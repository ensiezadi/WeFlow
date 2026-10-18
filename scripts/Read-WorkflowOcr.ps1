# Windows PowerShell 5.1 worker: local Windows OCR, newline-delimited JSON over stdin/stdout.
param([switch]$Probe)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime]
$asyncMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Await-OcrOperation($operation, [Type]$resultType) {
  $task = $asyncMethod.MakeGenericMethod($resultType).Invoke($null, @($operation))
  if (-not $task.Wait(15000)) { throw 'Windows OCR operation timed out' }
  return $task.GetAwaiter().GetResult()
}
$languages = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
$preferred = @($languages | Where-Object { $_ -like 'zh-*' }) + @($languages | Where-Object { $_ -eq 'en-US' }) + $languages
$selected = $preferred | Select-Object -First 1
if (-not $selected) { throw 'No Windows OCR language packs are installed' }
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language($selected)))
if (-not $engine) { throw 'Cannot initialize Windows OCR' }
[Console]::WriteLine((@{ ready=$true; languages=$languages; language=$selected } | ConvertTo-Json -Compress))
if ($Probe) { exit 0 }
while ($null -ne ($requestLine = [Console]::ReadLine())) {
  $request = $null
  $stream = $null
  $bitmap = $null
  $stage = 'request'
  try {
    $request = $requestLine | ConvertFrom-Json
    $stage = 'open-file'
    $file = Await-OcrOperation ([Windows.Storage.StorageFile]::GetFileFromPathAsync([IO.Path]::GetFullPath($request.path))) ([Windows.Storage.StorageFile])
    $stage = 'open-stream'
    $stream = Await-OcrOperation ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $stage = 'decode-image'
    $decoder = Await-OcrOperation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $stage = 'decode-bitmap'
    $bitmap = Await-OcrOperation ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Ignore)) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $stage = 'recognize'
    $recognized = Await-OcrOperation ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $text = (@($recognized.Lines | ForEach-Object { $_.Text }) -join "`n")
    [Console]::WriteLine((@{ id=$request.id; text=$text; language=$selected } | ConvertTo-Json -Compress))
  } catch {
    [Console]::WriteLine((@{ id=$request.id; error=($stage + ': ' + $_.Exception.GetBaseException().Message) } | ConvertTo-Json -Compress))
  } finally {
    if ($bitmap) { $bitmap.Dispose() }
    if ($stream) { $stream.Dispose() }
  }
}
