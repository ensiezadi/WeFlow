$ErrorActionPreference = 'Stop'
$diaryRoot = Split-Path -Parent $PSScriptRoot
$awRoot = Join-Path $diaryRoot 'local-tools\activitywatch-v0.14.1\activitywatch'
$snapshotRoot = Join-Path $diaryRoot 'local-diary-archive\snapshots'
New-Item -ItemType Directory -Path $snapshotRoot -Force | Out-Null
$settingsFile = Join-Path $snapshotRoot 'settings.json'
$captureSettings = if (Test-Path -LiteralPath $settingsFile) { Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
$captureSettings | Add-Member -NotePropertyName schemaVersion -NotePropertyValue 1 -Force
$captureSettings | Add-Member -NotePropertyName enabled -NotePropertyValue $false -Force
$captureSettings | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $settingsFile -Encoding utf8
Stop-ScheduledTask -TaskName 'WeFlow-LocalDeviceDiary' -ErrorAction SilentlyContinue
& (Join-Path $PSScriptRoot 'Stop-SnapshotListener.ps1')
$allowed = @('aw-server', 'aw-watcher-afk', 'aw-watcher-window') | ForEach-Object { Join-Path $awRoot "$_\$_.exe" }
Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -in $allowed } | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Write-Output 'Snapshot sampling paused. Existing archives are preserved.'
