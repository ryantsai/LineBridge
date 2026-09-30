$ErrorActionPreference = 'Stop'
$bridgeRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$bridgeRuntime = Join-Path $bridgeRoot 'runtime'
New-Item -ItemType Directory -Path $bridgeRuntime -Force | Out-Null
$bridgeNodeCommand = (Get-Command node.exe -ErrorAction Stop).Source
# nvm may resolve to a launcher shim. Package the actual Node runtime.
$bridgeNode = (& $bridgeNodeCommand -p 'process.execPath').Trim()
$bridgeVersion = (& $bridgeNode --version).Trim()
if ([int]$bridgeVersion.TrimStart('v').Split('.')[0] -lt 24) { throw 'LineBridge requires Node.js 24 or later for its LINE protocol worker.' }
Copy-Item -LiteralPath $bridgeNode -Destination (Join-Path $bridgeRuntime 'node.exe') -Force
$bridgeHash = (Get-FileHash -LiteralPath (Join-Path $bridgeRuntime 'node.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
$bridgeChecksums = (Invoke-WebRequest -Uri ('https://nodejs.org/dist/' + $bridgeVersion + '/SHASUMS256.txt')).Content
$bridgeExpected = ($bridgeChecksums -split "`n" | Where-Object { $_ -match '\swin-x64/node.exe\s*$' }) -replace '\s.*$',''
if ($bridgeHash -ne $bridgeExpected) { throw 'Node runtime checksum does not match the official Node.js distribution.' }
$bridgeLicense = Join-Path $bridgeRuntime 'node-LICENSE.txt'
Invoke-WebRequest -Uri ('https://raw.githubusercontent.com/nodejs/node/' + $bridgeVersion + '/LICENSE') -OutFile $bridgeLicense
$bridgeManifest = [ordered]@{ version=$bridgeVersion; sha256=$bridgeHash; source=('https://nodejs.org/dist/' + $bridgeVersion + '/win-x64/node.exe'); checksumVerified=$true; license='node-LICENSE.txt' }
$bridgeManifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $bridgeRuntime 'node-source.json') -Encoding utf8
Write-Output ('Prepared LINE worker runtime: ' + $bridgeVersion)
