# Stop only this checkout's resident snapshot agent, including an orphaned task child.
$listenerRoot = Split-Path -Parent $PSScriptRoot
$listenerExe = [IO.Path]::GetFullPath((Join-Path $listenerRoot 'node_modules\electron\dist\electron.exe'))
$listenerFile = [IO.Path]::GetFullPath((Join-Path $listenerRoot 'local-tools\diary-snapshot-agent.cjs'))
$listenerArchive = [IO.Path]::GetFullPath((Join-Path $listenerRoot 'local-diary-archive\snapshots'))
Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" | Where-Object {
  $_.ExecutablePath -eq $listenerExe -and
  $_.CommandLine -like ('*' + $listenerFile + '*') -and
  $_.CommandLine -like ('*' + $listenerArchive + '*') -and
  $_.CommandLine -match '(?:^|\s)--watch(?:\s|$)'
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
