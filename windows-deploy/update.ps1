<#
  Runs every 5 minutes via Task Scheduler.
  1. git pull (picks up code/UI changes pushed from Mac)
  2. Pulls the latest workbook from SharePoint via Microsoft Graph (graph_fetch.py)
  3. Rebuilds index.html from it (only if the file actually changed)

  Graph auth config: windows-deploy/graph_config.json (see graph_config.example.json).
  One-time interactive sign-in: python tb-dashboard-deploy\build\graph_fetch.py --login
#>

# CONFIG
$GitDir       = "C:\TBDashboard\repo"
$GraphScript  = "C:\TBDashboard\repo\tb-dashboard-deploy\build\graph_fetch.py"
$InboxDir     = "C:\TBDashboard\repo\windows-deploy\inbox"
$SiteDir      = "C:\TBDashboard\repo\tb-dashboard-deploy\site"
$BuildScript  = "C:\TBDashboard\repo\tb-dashboard-deploy\build\build_dashboard.py"
$Python       = "python"
$LogFile      = "C:\TBDashboard\update.log"
$StampFile    = "C:\TBDashboard\.last_source.sha256"

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

# 2. Pull latest workbook from SharePoint via Microsoft Graph
New-Item -ItemType Directory -Force -Path $InboxDir | Out-Null
$xlsxPath = Join-Path $InboxDir "latest.xlsx"

$ErrorActionPreference = 'Continue'
& $Python $GraphScript -o $xlsxPath 2>&1 | ForEach-Object { Log "graph: $_" }
$fetchCode = $LASTEXITCODE
$ErrorActionPreference = 'Stop'

if ($fetchCode -ne 0 -or -not (Test-Path $xlsxPath)) {
    Log "Could not fetch workbook from SharePoint this cycle; previous dashboard stays online"
    exit 0
}
$xlsx = Get-Item $xlsxPath

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
    Move-Item -Path $tmp -Destination $dest -Force
    Set-Content $StampFile $hash
    Log "Published - dashboard.cred-desk.com updated"
} else {
    Remove-Item $tmp -ErrorAction SilentlyContinue
    Log "Build FAILED for $($xlsx.Name); previous dashboard stays online"
    exit 1
}
