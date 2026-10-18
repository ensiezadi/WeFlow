param([switch]$Remove, [switch]$EnableLegacyBackground)

$ErrorActionPreference = 'Stop'
$taskName = 'WeFlow-LocalDeviceDiary'
if ($Remove) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  & (Join-Path $PSScriptRoot 'Stop-SnapshotListener.ps1')
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Output 'Local diary logon task removed. Existing archives are preserved.'
  return
}
if (-not $EnableLegacyBackground) { throw 'Legacy background startup is disabled by default. Enable capture in the app, or explicitly pass -EnableLegacyBackground for development only.' }
$runner = Join-Path $PSScriptRoot 'Capture-DeviceDiary.ps1'
$snapshotRoot = Join-Path (Split-Path -Parent $PSScriptRoot) 'local-diary-archive\snapshots'
New-Item -ItemType Directory -Path $snapshotRoot -Force | Out-Null
$settingsFile = Join-Path $snapshotRoot 'settings.json'
$captureSettings = if (Test-Path -LiteralPath $settingsFile) { Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
$captureSettings | Add-Member -NotePropertyName schemaVersion -NotePropertyValue 1 -Force
$captureSettings | Add-Member -NotePropertyName enabled -NotePropertyValue $true -Force
$captureSettings | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $settingsFile -Encoding utf8
$powershellExe = (Get-Process -Id $PID).Path
$account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $powershellExe `
  -Argument ('-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "' + $runner + '" -Watch') `
  -WorkingDirectory (Split-Path -Parent $PSScriptRoot)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $account
$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew -StartWhenAvailable
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
& (Join-Path $PSScriptRoot 'Stop-SnapshotListener.ps1')
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
  -Description 'Local workflow listener with game/fullscreen exclusion. Logon start only; no periodic launch. Focused window OCR, local text and editable work sessions; representative images max 20/day.' -Force | Out-Null
$statusFile = Join-Path $snapshotRoot 'agent-status.json'
$previousPid = if (Test-Path -LiteralPath $statusFile) { (Get-Content -LiteralPath $statusFile -Raw | ConvertFrom-Json).pid } else { 0 }
$startedAfter = [DateTimeOffset]::UtcNow
Start-ScheduledTask -TaskName $taskName
$deadline = [DateTimeOffset]::UtcNow.AddSeconds(30)
$healthy = $false
$attempts = 1
$nextAttemptAt = [DateTimeOffset]::UtcNow.AddSeconds(2)
while ([DateTimeOffset]::UtcNow -lt $deadline) {
  Start-Sleep -Milliseconds 500
  try {
    $agentStatus = Get-Content -LiteralPath $statusFile -Raw -ErrorAction Stop | ConvertFrom-Json
    if ($agentStatus.pid -ne $previousPid -and [DateTimeOffset]$agentStatus.heartbeatAt -ge $startedAfter) { $healthy = $true; break }
  } catch { }
  # Task Scheduler may still be cleaning up the old interactive process on the first start.
  if ((Get-ScheduledTask -TaskName $taskName).State -ne 'Running' -and $attempts -lt 3 -and [DateTimeOffset]::UtcNow -ge $nextAttemptAt) {
    Start-ScheduledTask -TaskName $taskName
    $attempts++
    $nextAttemptAt = [DateTimeOffset]::UtcNow.AddSeconds(2)
  }
}
if (-not $healthy) { throw 'Workflow listener did not report a new heartbeat. See logs/device-diary and Scheduled Task history.' }
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName,State
