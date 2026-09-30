param([switch]$Headless,[switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$bridgeRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$bridgeData = if ($env:LINE_BRIDGE_DATA) { [IO.Path]::GetFullPath($env:LINE_BRIDGE_DATA) } else { Join-Path $bridgeRoot 'data' }
$bridgeExe = if ($Headless) { Join-Path $bridgeRoot 'target\release\line-bridge-service.exe' } else { Join-Path $bridgeRoot 'target\release\LineBridge.exe' }
$bridgePidPath = Join-Path $bridgeData 'server.pid'
if (Test-Path -LiteralPath $bridgePidPath) {
  $bridgeRecorded = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int](Get-Content -LiteralPath $bridgePidPath))
  if ($bridgeRecorded -and $bridgeRecorded.ExecutablePath -eq $bridgeExe) {
    if (-not $Headless) { Start-Process -FilePath $bridgeExe -WorkingDirectory $bridgeRoot -WindowStyle Hidden }
    elseif (-not $NoBrowser) { Start-Process 'http://localhost:3210' -WindowStyle Hidden }
    Write-Output 'LineBridge is already running.'
    return
  }
  if ($bridgeRecorded) { & (Join-Path $PSScriptRoot 'stop.ps1') -DataPath $bridgeData }
}
if (-not (Test-Path -LiteralPath $bridgeExe)) {
  Push-Location $bridgeRoot
  try {
    & npm.cmd run build:protocol
    if ($LASTEXITCODE) { throw 'LINE protocol bundle failed.' }
    if ($Headless) { & cargo build --release -p line-bridge-core --bin line-bridge-service }
    else { & npm.cmd run desktop:build }
    if ($LASTEXITCODE) { throw 'LineBridge build failed.' }
  } finally { Pop-Location }
}
New-Item -ItemType Directory -Force -Path $bridgeData | Out-Null
$bridgeOldRoot = $env:LINE_BRIDGE_ROOT
$bridgeOldData = $env:LINE_BRIDGE_DATA
try {
  $env:LINE_BRIDGE_ROOT = $bridgeRoot
  $env:LINE_BRIDGE_DATA = $bridgeData
  $bridgeProcess = Start-Process -FilePath $bridgeExe -WorkingDirectory $bridgeRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $bridgeData 'server.log') -RedirectStandardError (Join-Path $bridgeData 'server-error.log')
} finally { $env:LINE_BRIDGE_ROOT = $bridgeOldRoot; $env:LINE_BRIDGE_DATA = $bridgeOldData }
$bridgeReady = $false
for ($bridgeAttempt = 0; $bridgeAttempt -lt 50; $bridgeAttempt++) {
  Start-Sleep -Milliseconds 300
  if ($bridgeProcess.HasExited) { throw 'LineBridge startup failed. See data/server-error.log.' }
  try { $bridgeHealth = Invoke-RestMethod 'http://127.0.0.1:3211/health' -TimeoutSec 1; if ($bridgeHealth.service -eq 'line-bridge' -and $bridgeHealth.backend -eq 'rust') { $bridgeReady=$true; break } } catch {}
}
if (-not $bridgeReady) { throw 'LineBridge did not become ready. Check ports 3210/3211 and data/server-error.log.' }
if ($Headless -and -not $NoBrowser) { Start-Process 'http://localhost:3210' -WindowStyle Hidden }
Write-Output 'LineBridge: Rust service ready at http://localhost:3210'
Write-Output 'AI gateway: http://127.0.0.1:3211 (authentication required)'
