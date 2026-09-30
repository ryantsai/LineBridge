param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$bridgeRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$bridgeData = Join-Path $bridgeRoot 'data'
$bridgeMain = Join-Path $bridgeRoot 'server\main.mjs'
New-Item -ItemType Directory -Force -Path $bridgeData | Out-Null
$bridgeNode = (Get-Command node.exe -ErrorAction Stop).Source
$bridgeMajor = [int]((& $bridgeNode --version).TrimStart('v').Split('.')[0])
if ($bridgeMajor -lt 24) { throw 'LINE Bridge requires Node.js 24 or newer.' }
try {
  $bridgeHealth = Invoke-RestMethod 'http://127.0.0.1:3211/health' -TimeoutSec 2
  if ($bridgeHealth.service -eq 'line-bridge') {
    if (-not $NoBrowser) { Start-Process 'http://localhost:3210' -WindowStyle Hidden }
    Write-Output 'LINE Bridge is already running: http://localhost:3210'
    return
  }
} catch {}
$bridgeProcess = Start-Process -FilePath $bridgeNode -ArgumentList ('"' + $bridgeMain + '"') -WorkingDirectory $bridgeRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $bridgeData 'server.log') -RedirectStandardError (Join-Path $bridgeData 'server-error.log')
for ($bridgeAttempt = 0; $bridgeAttempt -lt 30; $bridgeAttempt++) {
  Start-Sleep -Milliseconds 300
  if ($bridgeProcess.HasExited) { throw 'Service startup failed. See data/server-error.log.' }
  try { $bridgeHealth = Invoke-RestMethod 'http://127.0.0.1:3211/health' -TimeoutSec 1; if ($bridgeHealth.service -eq 'line-bridge') { break } } catch {}
}
if ($bridgeHealth.service -ne 'line-bridge') { throw 'Service did not become ready. See data/server-error.log.' }
if (-not $NoBrowser) { Start-Process 'http://localhost:3210' -WindowStyle Hidden }
Write-Output 'LINE Bridge dashboard: http://localhost:3210'
Write-Output 'AI gateway: http://127.0.0.1:3211 (authentication required)'
