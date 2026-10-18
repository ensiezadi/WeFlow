param([switch]$Watch)

$ErrorActionPreference = 'Stop'
$diaryRoot = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $diaryRoot 'node_modules\electron\dist\electron.exe'
$agent = Join-Path $diaryRoot 'local-tools\diary-snapshot-agent.cjs'
$snapshotRoot = Join-Path $diaryRoot 'local-diary-archive\snapshots'
$snapshotLogs = Join-Path $diaryRoot 'logs\device-diary'
New-Item -ItemType Directory -Path $snapshotLogs -Force | Out-Null
$env:ELECTRON_RUN_AS_NODE = $null
$agentArguments = '"' + $agent + '" --root "' + $snapshotRoot + '"'
if ($Watch) { $agentArguments += ' --watch' }
$captureProcess = Start-Process -FilePath $electron -ArgumentList $agentArguments `
  -WorkingDirectory $diaryRoot -WindowStyle Hidden -Wait -PassThru `
  -RedirectStandardOutput (Join-Path $snapshotLogs 'snapshot.stdout.log') `
  -RedirectStandardError (Join-Path $snapshotLogs 'snapshot.stderr.log')
exit $captureProcess.ExitCode
