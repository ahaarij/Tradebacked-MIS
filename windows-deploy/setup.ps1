<#
  One-time setup: installs the Tradebacked dashboard service on the Windows server.
  Run in PowerShell as Administrator.

  Usage:
    .\setup.ps1 -RepoUrl https://github.com/YOUR-USERNAME/YOUR-REPO.git

  What it does:
    1. Clones the git repo to C:\TBDashboard\repo\
    2. Creates C:\TBDashboard\www\ for the served HTML
    3. Copies serve.py and run_serve.bat so the HTTP server can start
    4. Creates NSSM service "tb-dashboard" (Python HTTP server on port 5002)
    5. Creates Task Scheduler job to git pull + rebuild every 15 minutes
    6. Runs the first build immediately
#>
param(
    [Parameter(Mandatory=$true)]
    [string]$RepoUrl
)

$ErrorActionPreference = 'Stop'

$p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script as Administrator (right-click PowerShell → Run as administrator).'
}

$InstallDir = 'C:\TBDashboard'
$RepoDir    = 'C:\TBDashboard\repo'
$WebRoot    = 'C:\TBDashboard\www'
$UpdateScript = "$InstallDir\update.ps1"

function Step([string]$m) { Write-Host "`n==> $m" -ForegroundColor Cyan }

# ── 1. Clone repo ────────────────────────────────────────────────────────────
Step "Cloning repo to $RepoDir"
New-Item -ItemType Directory -Force -Path $InstallDir, $WebRoot | Out-Null
if (Test-Path "$RepoDir\.git") {
    Write-Host '  Repo already exists — pulling latest instead'
    Push-Location $RepoDir; & git pull origin main; Pop-Location
} else {
    & git clone $RepoUrl $RepoDir
}

# ── 2. Copy service files from repo ──────────────────────────────────────────
Step 'Copying service files'
Copy-Item "$RepoDir\windows-deploy\serve.py"      $InstallDir -Force
Copy-Item "$RepoDir\windows-deploy\run_serve.bat"  $InstallDir -Force
Copy-Item "$RepoDir\windows-deploy\update.ps1"     $UpdateScript -Force

# Copy the xlsx.js library into www (used by in-browser "Load updated MIS" button)
$XlsxJs = "$RepoDir\tb-dashboard-deploy\site\xlsx.full.min.js"
if (Test-Path $XlsxJs) { Copy-Item $XlsxJs $WebRoot -Force }

# ── 3. Install Python dependency ─────────────────────────────────────────────
Step 'Installing openpyxl'
& python -m pip install --quiet openpyxl
if ($LASTEXITCODE -ne 0) {
    Write-Warning 'pip install failed. Run manually: python -m pip install openpyxl'
}

# ── 4. NSSM service ──────────────────────────────────────────────────────────
Step 'Creating NSSM service "tb-dashboard" (HTTP server on port 5002)'
if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) {
    Write-Warning 'nssm not found in PATH. Run these manually after:'
    Write-Host '  nssm install tb-dashboard "C:\TBDashboard\run_serve.bat"'
    Write-Host '  nssm set tb-dashboard AppDirectory C:\TBDashboard'
    Write-Host '  nssm start tb-dashboard'
} else {
    & nssm stop tb-dashboard 2>$null
    & nssm remove tb-dashboard confirm 2>$null
    & nssm install tb-dashboard "C:\TBDashboard\run_serve.bat"
    & nssm set tb-dashboard AppDirectory $InstallDir
    & nssm set tb-dashboard DisplayName 'Tradebacked MIS Dashboard'
    & nssm set tb-dashboard Start SERVICE_AUTO_START
    & nssm start tb-dashboard
    Write-Host '  Service started.'
}

# ── 5. Task Scheduler job ────────────────────────────────────────────────────
Step 'Scheduling auto-rebuild every 15 minutes'
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
           -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$UpdateScript`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
           -RepetitionInterval (New-TimeSpan -Minutes 15) `
           -RepetitionDuration (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName 'TB Dashboard auto-refresh' `
    -Action $action -Trigger $trigger -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
Write-Host '  Task registered.'

# ── 6. First build ───────────────────────────────────────────────────────────
Step 'Running first build'
& powershell -NoProfile -ExecutionPolicy Bypass -File $UpdateScript
Write-Host '  Done.'

Write-Host @"

--------------------------------------------------------------------
 Setup complete

 Dashboard:   http://localhost:5002
 Repo:        $RepoDir
 Log:         C:\TBDashboard\update.log
 Rebuild now: powershell -ExecutionPolicy Bypass -File $UpdateScript

 NEXT STEPS — add the subdomain to your Cloudflare tunnel:

 1. Edit C:\Windows\System32\config\systemprofile\.cloudflared\config.yml
    and add under ingress (before the catch-all):

      - hostname: dashboard.cred-desk.com
        service: http://localhost:5002

 2. cloudflared.exe tunnel route dns mis-app dashboard.cred-desk.com
    Restart-Service cloudflared

 3. Cloudflare Zero Trust → Access → Applications → Add:
    Domain: dashboard.cred-desk.com
    Policy: Allow, Emails (list who gets access)
--------------------------------------------------------------------
"@ -ForegroundColor Green
