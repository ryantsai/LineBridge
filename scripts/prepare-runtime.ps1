$ErrorActionPreference = 'Stop'
$bridgeRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
& node (Join-Path $bridgeRoot 'scripts/prepare-runtime.mjs')
if ($LASTEXITCODE) { throw 'Runtime preparation failed.' }
