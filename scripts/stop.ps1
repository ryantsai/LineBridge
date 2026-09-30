param([string]$DataPath)
& (Join-Path $PSScriptRoot 'stop-rust.ps1') @PSBoundParameters
