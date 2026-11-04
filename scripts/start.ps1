param([switch]$LocalOnly, [switch]$NoOpen, [int]$Port = 8080, [string]$DataDir = '')
$ErrorActionPreference = 'Stop'
# A Node/PowerShell 7 parent can pass an incompatible module path to Windows PowerShell.
if ($PSVersionTable.PSEdition -eq 'Desktop') { $env:PSModulePath = "$PSHOME\Modules;${env:ProgramFiles}\WindowsPowerShell\Modules" }
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtime = Get-Content -LiteralPath (Join-Path $projectRoot 'runtime.json') -Raw | ConvertFrom-Json
$nodeDir = Join-Path $projectRoot ('.tools/node-v' + $runtime.node.version + '-win-x64')
$nodeExe = Join-Path $nodeDir 'node.exe'
$lockHash = (Get-FileHash -LiteralPath (Join-Path $projectRoot 'package-lock.json') -Algorithm SHA256).Hash
$stampPath = Join-Path $projectRoot '.tools/dependency-lock.sha256'
$installedHash = if (Test-Path -LiteralPath $stampPath) { (Get-Content -LiteralPath $stampPath -Raw).Trim() } else { '' }
if ($lockHash -ne $installedHash -or -not (Test-Path -LiteralPath $nodeExe) -or -not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules/tsx/package.json')) -or (-not $LocalOnly -and -not (Test-Path -LiteralPath (Join-Path $projectRoot '.tools/cloudflared.exe')))) {
  & (Join-Path $PSScriptRoot 'setup.ps1') -LocalOnly:$LocalOnly
}
$env:PATH = $nodeDir + ';' + $env:PATH
Push-Location $projectRoot
try {
  & (Join-Path $nodeDir 'npm.cmd') run build
  if ($LASTEXITCODE -ne 0) { throw 'Build failed; existing saves have not been changed.' }
  $hostArgs = @('scripts/host.mjs', '--port', [string]$Port)
  if ($LocalOnly) { $hostArgs += '--local' }
  if ($NoOpen) { $hostArgs += '--no-open' }
  if ($DataDir) { $hostArgs += @('--data-dir', $DataDir) }
  & $nodeExe @hostArgs
  if ($LASTEXITCODE -ne 0) { throw 'Host exited with an error.' }
} finally { Pop-Location }
