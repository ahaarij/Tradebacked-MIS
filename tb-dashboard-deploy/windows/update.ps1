<#
.SYNOPSIS
  Rebuild and publish the Tradebacked dashboard.
    .\update.ps1                      newest .xlsx/.xlsm in the inbox (skips if unchanged)
    .\update.ps1 -Workbook D:\MIS.xlsx
    .\update.ps1 -Force               rebuild even if the workbook hasn't changed
#>
param([string]$Workbook, [switch]$Force)

$ErrorActionPreference = 'Stop'
$AppDir = $PSScriptRoot
$cfg    = Get-Content "$AppDir\config.json" -Raw | ConvertFrom-Json
$logf   = "$AppDir\update.log"
$stamp  = "$AppDir\.last_source.sha256"
function Log([string]$m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"; Write-Host $line; Add-Content $logf $line }

if (-not $Workbook) {
  # Newest by the later of creation (upload) time and last-write time; ignore Excel lock files
  $f = Get-ChildItem $cfg.Inbox -File |
       Where-Object { $_.Extension -in '.xlsx', '.xlsm' -and $_.Name -notlike '~$*' } |
       Sort-Object { if ($_.CreationTime -gt $_.LastWriteTime) { $_.CreationTime } else { $_.LastWriteTime } } -Descending |
       Select-Object -First 1
  if (-not $f) { Log "no workbook found in $($cfg.Inbox)"; exit 0 }
  $Workbook = $f.FullName
}
if (-not (Test-Path $Workbook)) { Log "file not found: $Workbook"; exit 1 }

# Skip a file that is still being copied in
$s1 = (Get-Item $Workbook).Length; Start-Sleep -Seconds 5; $s2 = (Get-Item $Workbook).Length
if ($s1 -ne $s2) { Log "$(Split-Path $Workbook -Leaf) is still being copied; will retry"; exit 0 }

$hash = (Get-FileHash $Workbook -Algorithm SHA256).Hash
if (-not $Force -and (Test-Path $stamp) -and ((Get-Content $stamp -Raw).Trim() -eq $hash)) { exit 0 }

# Build to a temp name (.tmp is not served by IIS), then swap it in
$dest = Join-Path $cfg.WebRoot 'index.html'
$tmp  = Join-Path $cfg.WebRoot 'index.building.tmp'
$ErrorActionPreference = 'Continue'
& $cfg.Python "$AppDir\build\build_dashboard.py" $Workbook -o $tmp
$code = $LASTEXITCODE
$ErrorActionPreference = 'Stop'

if ($code -eq 0 -and (Test-Path $tmp)) {
  if (Test-Path $dest) { [IO.File]::Replace($tmp, $dest, $null) } else { Move-Item $tmp $dest }
  Set-Content $stamp $hash
  Log "published dashboard from $(Split-Path $Workbook -Leaf)"
} else {
  Remove-Item $tmp -ErrorAction SilentlyContinue
  Log "build FAILED for $(Split-Path $Workbook -Leaf); the previous dashboard is still online"
  exit 1
}
