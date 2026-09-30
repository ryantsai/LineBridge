$ErrorActionPreference = 'Stop'
$bridgeRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$bridgePidPath = Join-Path $bridgeRoot 'data\server.pid'
if (-not (Test-Path -LiteralPath $bridgePidPath)) { Write-Output 'No running service is recorded.'; return }
$bridgePid = [int](Get-Content -LiteralPath $bridgePidPath)
$bridgeProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$bridgePid"
$bridgeExpectedMain = Join-Path $bridgeRoot 'server\main.mjs'
if ($null -eq $bridgeProcess) { Remove-Item -LiteralPath $bridgePidPath; Write-Output 'Service is already stopped.'; return }
if (-not $bridgeProcess.CommandLine.Contains($bridgeExpectedMain)) { throw 'Recorded PID belongs to another process. It was not stopped.' }
# Kill only connector children of this app, then the verified service process.
Get-CimInstance Win32_Process -Filter "ParentProcessId=$bridgePid" | Where-Object { $_.ExecutablePath -eq (Join-Path $bridgeRoot 'tools\cloudflared.exe') } | ForEach-Object { Stop-Process -Id $_.ProcessId }
Stop-Process -Id $bridgePid
Remove-Item -LiteralPath $bridgePidPath -ErrorAction SilentlyContinue
Write-Output 'LINE Bridge stopped. Persistent Tailscale Serve routes, if configured, should be stopped from the dashboard first.'
