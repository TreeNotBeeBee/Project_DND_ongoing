param([switch]$LocalOnly, [switch]$Browsers, [string]$DownloadCache = $env:JIGE_DOWNLOAD_CACHE)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -eq 'Desktop') { $env:PSModulePath = "$PSHOME\Modules;${env:ProgramFiles}\WindowsPowerShell\Modules" }
$projectRoot = Split-Path -Parent $PSScriptRoot
$toolDir = Join-Path $projectRoot '.tools'
. (Join-Path $PSScriptRoot 'runtime-download.ps1')
$runtime = Get-Content -LiteralPath (Join-Path $projectRoot 'runtime.json') -Raw | ConvertFrom-Json
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { throw 'This pinned runtime package requires Windows x64.' }
New-Item -ItemType Directory -Path $toolDir -Force | Out-Null
$nodeDirectory = Join-Path $toolDir ('node-v' + $runtime.node.version + '-win-x64')
$nodeExecutable = Join-Path $nodeDirectory 'node.exe'
if (-not (Test-Path -LiteralPath $nodeExecutable)) {
  $archiveName = 'node-v' + $runtime.node.version + '-win-x64.zip'
  $archivePath = Join-Path $toolDir $archiveName
  Get-VerifiedFile ('https://nodejs.org/dist/v' + $runtime.node.version + '/' + $archiveName) $archivePath $runtime.node.sha256 $DownloadCache
  Expand-Archive -LiteralPath $archivePath -DestinationPath $toolDir -Force
}
$installedVersion = & $nodeExecutable --version
if ($installedVersion -ne ('v' + $runtime.node.version)) { throw 'Project Node runtime version mismatch.' }
$env:PATH = $nodeDirectory + ';' + $env:PATH
if (-not $LocalOnly) {
  Get-VerifiedFile ('https://github.com/cloudflare/cloudflared/releases/download/' + $runtime.cloudflared.version + '/' + $runtime.cloudflared.file) (Join-Path $toolDir 'cloudflared.exe') $runtime.cloudflared.sha256 $DownloadCache
}
Push-Location $projectRoot
try {
  & (Join-Path $nodeDirectory 'npm.cmd') ci --ignore-scripts
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
  & $nodeExecutable -e "const D=require('better-sqlite3');const d=new D(':memory:');console.log('SQLite',d.prepare('select sqlite_version() as v').get().v);d.close()"
  if ($LASTEXITCODE -ne 0) { throw 'SQLite runtime verification failed.' }
  (Get-FileHash -LiteralPath (Join-Path $projectRoot 'package-lock.json') -Algorithm SHA256).Hash | Set-Content -LiteralPath (Join-Path $toolDir 'dependency-lock.sha256') -Encoding Ascii
  if ($Browsers) {
    & $nodeExecutable 'node_modules/@playwright/test/cli.js' install chromium
    if ($LASTEXITCODE -ne 0) { throw 'Browser installation failed.' }
  }
} finally { Pop-Location }
Write-Host ('Ready: project-private Node ' + $runtime.node.version + '. System Node was not changed.')
