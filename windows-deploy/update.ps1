<#
  Rebuilds the Tradebacked dashboard from the SharePoint-synced MIS Excel.
  Runs every 15 minutes via Task Scheduler.
  Only rebuilds when the Excel file has actually changed (SHA-256 check).
  Also pulls latest code from git before rebuilding.

  Edit $SharePointFolder and $ExcelPattern to match your setup.
#>

# ── CONFIG ───────────────────────────────────────────────────────────────────
$GitDir           = "C:\TBDashboard\repo"   # where the repo is cloned on the server
$SharePointFolder = "C:\Users\Administrator\KAYZEE CURTAINS & UPHOLSTERY FABRICS TRADING LLC\Cred-Desk - Documents"
$ExcelPattern     = "Tradebacked*MIS*.xls?"   # wildcards match the filename however it's named
$WebRoot          = "C:\TBDashboard\www"
$BuildScript      = "C:\TBDashboard\repo\tb-dashboard-deploy\build\build_dashboard.py"
$Python           = "python"
$LogFile          = "C:\TBDashboard\update.log"
$StampFile        = "C:\TBDashboard\.last_source.sha256"
# ─────────────────────────────────────────────────────────────────────────────

function Log([string]$m) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"
    Write-Host $line
    Add-Content -Path $LogFile -Value $line
}

# Pull latest code from git (UI/logic updates pushed from Mac)
if (Test-Path "$GitDir\.git") {
    Push-Location $GitDir
    & git pull origin main 2>&1 | ForEach-Object { Log "git: $_" }
    Pop-Location
}

# Find the newest matching Excel in the SharePoint folder (ignore Excel lock files)
$xlsx = Get-ChildItem -Path $SharePointFolder -Recurse -File |
        Where-Object { $_.Name -like $ExcelPattern -and $_.Name -notlike '~$*' } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1

if (-not $xlsx) {
    Log "No matching Excel found in $SharePointFolder (pattern: $ExcelPattern)"
    exit 0
}

# Wait to make sure the file isn't still being synced
$s1 = $xlsx.Length
Start-Sleep -Seconds 5
$xlsx.Refresh()
$s2 = $xlsx.Length
if ($s1 -ne $s2) {
    Log "$($xlsx.Name) is still syncing from SharePoint; will retry next cycle"
    exit 0
}

# Skip rebuild if file hasn't changed since last run
$hash = (Get-FileHash $xlsx.FullName -Algorithm SHA256).Hash
if ((Test-Path $StampFile) -and ((Get-Content $StampFile -Raw).Trim() -eq $hash)) {
    exit 0  # no change, nothing to do
}

Log "Rebuilding dashboard from $($xlsx.Name)..."

# Build to a temp file first, then swap — so the live page is never half-written
$dest = Join-Path $WebRoot "index.html"
$tmp  = Join-Path $WebRoot "index.building.tmp"

$ErrorActionPreference = 'Continue'
& $Python $BuildScript $xlsx.FullName -o $tmp 2>&1
$code = $LASTEXITCODE
$ErrorActionPreference = 'Stop'

if ($code -eq 0 -and (Test-Path $tmp)) {
    if (Test-Path $dest) {
        [IO.File]::Replace($tmp, $dest, $null)
    } else {
        Move-Item $tmp $dest
    }
    Set-Content $StampFile $hash
    Log "Published — dashboard is live at dashboard.cred-desk.com"
} else {
    Remove-Item $tmp -ErrorAction SilentlyContinue
    Log "Build FAILED for $($xlsx.Name); previous dashboard stays online"
    exit 1
}
