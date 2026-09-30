param([switch]$Headless,[switch]$NoBrowser)
& (Join-Path $PSScriptRoot 'start-rust.ps1') @PSBoundParameters
