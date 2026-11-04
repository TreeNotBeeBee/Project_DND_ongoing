# Shared by setup and isolated distribution verification. Cached archives are
# treated exactly like downloads: the pinned SHA256 must match before use.
function Get-VerifiedFile([string]$Url, [string]$Destination, [string]$Sha256, [string]$DownloadCache = '') {
  if ($Sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid pinned download SHA256.' }
  if (Test-Path -LiteralPath $Destination -PathType Leaf) {
    if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -ieq $Sha256) { return }
  }
  if ($DownloadCache) {
    $names = @((Split-Path -Leaf ([Uri]$Url).AbsolutePath), (Split-Path -Leaf $Destination)) | Select-Object -Unique
    foreach ($name in $names) {
      $cached = Join-Path $DownloadCache $name
      if (Test-Path -LiteralPath $cached -PathType Leaf) {
        if ((Get-FileHash -LiteralPath $cached -Algorithm SHA256).Hash -ine $Sha256) { throw ('Cached download checksum mismatch: ' + $cached) }
        Copy-Item -LiteralPath $cached -Destination $Destination -Force
        Write-Host ('Using verified download cache: ' + $name)
        return
      }
    }
  }
  $pending = $Destination + '.partial-' + [Guid]::NewGuid().ToString('N')
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $pending
    if ((Get-FileHash -LiteralPath $pending -Algorithm SHA256).Hash -ine $Sha256) { throw ('Download checksum mismatch: ' + $Destination) }
    Move-Item -LiteralPath $pending -Destination $Destination -Force
  } finally {
    if (Test-Path -LiteralPath $pending -PathType Leaf) { Remove-Item -LiteralPath $pending -Force }
  }
}
