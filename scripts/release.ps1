# Forward arguments as an array so paths with spaces remain a single argument.
$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'release.mjs') @args
exit $LASTEXITCODE
