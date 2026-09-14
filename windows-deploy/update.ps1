<#
  Runs every 5 minutes via Task Scheduler.
  1. git pull (picks up code/UI changes pushed from Mac)
  2. Rebuilds index.html from the SharePoint-synced Excel (only if file changed)

  Edit $SharePointFolder and $ExcelPattern to match your setup.
#>

# CONFIG
$GitDir           = "C:\TBDashboard\repo"
$SharePointFolder = "C:\Users\Administrator\KAYZEE CURTAINS & UPHOLSTERY FABRICS TRADING LLC\Cred-Desk - Documents"
$ExcelPattern     = "Tradebacked*MIS*.xls?"
$SiteDir          = "C:\TBDashboard\repo\tb-dashboard-deploy\site"
$BuildScript      = "C:\TBDashboard\repo\tb-dashboard-deploy\build\build_dashboard.py"
$Python           = "python"
$LogFile          = "C:\TBDashboard\update.log"
$StampFile        = "C:\TBDashboard\.last_source.sha256"

function Log([string]$m) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"
    Write-Host $line
    Add-Content -Path $LogFile -Value $line
}

# 1. git pull
if (Test-Path "$GitDir\.git") {
    Push-Location $GitDir
    $before = & git rev-parse HEAD 2>$null
    & git pull origin main 2>&1 | ForEach-Object { Log "git: $_" }
    $after = & git rev-parse HEAD 2>$null
    Pop-Location
    if ($before -ne $after) {
        Log "Code updated - restarting tb-dashboard service"
        Restart-Service tb-dashboard -ErrorAction SilentlyContinue
    }
}

# 2. Find newest Excel in SharePoint folder
$xlsx = Get-ChildItem -Path $SharePointFolder -Recurse -File |
        Where-Object { $_.Name -like $ExcelPattern -and $_.Name -notlike '~$*' } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1

if (-not $xlsx) {
    Log "No matching Excel found in $SharePointFolder (pattern: $ExcelPattern)"
    exit 0
}

# Wait to confirm file is not still syncing
$s1 = $xlsx.Length
Start-Sleep -Seconds 5
$xlsx.Refresh()
$s2 = $xlsx.Length
if ($s1 -ne $s2) {
    Log "$($xlsx.Name) is still syncing; will retry next cycle"
    exit 0
}

# 3. Skip rebuild if Excel unchanged
$hash = (Get-FileHash $xlsx.FullName -Algorithm SHA256).Hash
if ((Test-Path $StampFile) -and ((Get-Content $StampFile -Raw).Trim() -eq $hash)) {
    exit 0
}

Log "Rebuilding from $($xlsx.Name)..."

# Build to temp then swap so live page never goes down mid-write
$dest = Join-Path $SiteDir "index.html"
$tmp  = Join-Path $SiteDir "index.building.tmp"

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
    Log "Published - dashboard.cred-desk.com updated"
} else {
    Remove-Item $tmp -ErrorAction SilentlyContinue
    Log "Build FAILED for $($xlsx.Name); previous dashboard stays online"
    exit 1
}
