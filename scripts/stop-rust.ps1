param([string]$DataPath)
$ErrorActionPreference = 'Stop'
$bridgeRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$bridgeData = if ($DataPath) { [IO.Path]::GetFullPath($DataPath) } elseif ($env:LINE_BRIDGE_DATA) { [IO.Path]::GetFullPath($env:LINE_BRIDGE_DATA) } else { Join-Path $bridgeRoot 'data' }
$bridgePidPath = Join-Path $bridgeData 'server.pid'
if (-not (Test-Path -LiteralPath $bridgePidPath)) { Write-Output 'No LineBridge service is recorded.'; return }
$bridgePid = [int](Get-Content -LiteralPath $bridgePidPath)
$bridgeProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$bridgePid"
if ($null -eq $bridgeProcess) { Remove-Item -LiteralPath $bridgePidPath; Write-Output 'LineBridge is already stopped.'; return }
$bridgeAllowed = @((Join-Path $bridgeRoot 'target\release\LineBridge.exe'),(Join-Path $bridgeRoot 'target\release\line-bridge-service.exe'),(Join-Path $bridgeRoot 'target\debug\LineBridge.exe'),(Join-Path $bridgeRoot 'target\debug\line-bridge-service.exe'))
$bridgeLegacy = $bridgeProcess.ExecutablePath.EndsWith('\node.exe') -and $bridgeProcess.CommandLine.Contains((Join-Path $bridgeRoot 'server\main.mjs'))
if (-not $bridgeLegacy -and $bridgeProcess.ExecutablePath -notin $bridgeAllowed) { throw 'Recorded PID belongs to another application; it was not stopped.' }
# Children are accepted only when both their parent and app-specific path match.
$bridgeChildren = Get-CimInstance Win32_Process -Filter "ParentProcessId=$bridgePid"
foreach ($bridgeChild in $bridgeChildren) {
  if ($bridgeChild.ExecutablePath -eq (Join-Path $bridgeRoot 'tools\cloudflared.exe') -or $bridgeChild.CommandLine.Contains((Join-Path $bridgeRoot 'protocol\line-worker.cjs')) -or $bridgeChild.CommandLine.Contains((Join-Path $bridgeRoot 'protocol\worker.mjs'))) { Stop-Process -Id $bridgeChild.ProcessId -ErrorAction SilentlyContinue }
}
Stop-Process -Id $bridgePid
Remove-Item -LiteralPath $bridgePidPath -ErrorAction SilentlyContinue
Write-Output 'LineBridge stopped. Stop any persistent Tailscale Serve route in the dashboard before shutting down.'
