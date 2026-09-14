<#
  One-time setup: installs the Tradebacked dashboard on the Windows server.
  Run in PowerShell as Administrator.

  Usage:
    .\setup.ps1 -RepoUrl https://github.com/ahaarij/Tradebacked-MIS.git

  What it does:
    1. Clones the git repo to C:\TBDashboard\repo\
    2. Installs Python dependencies (flask, werkzeug, openpyxl)
    3. Creates NSSM service "tb-dashboard" (Flask on port 5002)
    4. Creates Task Scheduler job: git pull + Excel rebuild every 5 minutes
    5. Runs the first build immediately
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

$InstallDir   = 'C:\TBDashboard'
$RepoDir      = 'C:\TBDashboard\repo'
$UpdateScript = 'C:\TBDashboard\repo\windows-deploy\update.ps1'

function Step([string]$m) { Write-Host "`n==> $m" -ForegroundColor Cyan }

# ── 1. Clone repo ────────────────────────────────────────────────────────────
Step "Cloning repo to $RepoDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
if (Test-Path "$RepoDir\.git") {
    Write-Host '  Repo already exists — pulling latest'
    Push-Location $RepoDir; & git pull origin main; Pop-Location
} else {
    & git clone $RepoUrl $RepoDir
}

# ── 2. Install Python dependencies ───────────────────────────────────────────
Step 'Installing Python dependencies'
& python -m pip install --quiet flask werkzeug openpyxl
if ($LASTEXITCODE -ne 0) {
    Write-Warning 'pip install failed. Run manually: python -m pip install flask werkzeug openpyxl'
}

# ── 3. NSSM service (Flask on port 5002) ─────────────────────────────────────
Step 'Creating NSSM service "tb-dashboard" (Flask on port 5002)'
if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) {
    Write-Warning 'nssm not found in PATH. Run these manually:'
    Write-Host '  nssm install tb-dashboard "C:\TBDashboard\repo\windows-deploy\run_serve.bat"'
    Write-Host '  nssm set tb-dashboard AppDirectory C:\TBDashboard\repo'
    Write-Host '  nssm start tb-dashboard'
} else {
    & nssm stop   tb-dashboard 2>$null
    & nssm remove tb-dashboard confirm 2>$null
    & nssm install tb-dashboard "$RepoDir\windows-deploy\run_serve.bat"
    & nssm set tb-dashboard AppDirectory $RepoDir
    & nssm set tb-dashboard DisplayName 'Tradebacked MIS Dashboard'
    & nssm set tb-dashboard Start SERVICE_AUTO_START
    & nssm start tb-dashboard
    Write-Host '  Service started on port 5002.'
}

# ── 4. Task Scheduler: git pull + Excel rebuild every 5 minutes ──────────────
Step 'Scheduling auto-refresh every 5 minutes'
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
           -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$UpdateScript`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
           -RepetitionInterval (New-TimeSpan -Minutes 5) `
           -RepetitionDuration (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName 'TB Dashboard auto-refresh' `
    -Action $action -Trigger $trigger -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
Write-Host '  Task registered: runs every 5 minutes as SYSTEM.'

# ── 5. First build ───────────────────────────────────────────────────────────
Step 'Running first build'
& powershell -NoProfile -ExecutionPolicy Bypass -File $UpdateScript
Write-Host '  Done.'

Write-Host @"

--------------------------------------------------------------------
 Setup complete

 Dashboard:    http://localhost:5002
 Repo:         $RepoDir
 Log:          C:\TBDashboard\repo\windows-deploy\update.log
 Rebuild now:  powershell -ExecutionPolicy Bypass -File "$UpdateScript"

 ADD TO CLOUDFLARE TUNNEL
 Edit: C:\Windows\System32\config\systemprofile\.cloudflared\config.yml

   ingress:
     - hostname: mis.cred-desk.com
       service: http://localhost:5001
     - hostname: dashboard.cred-desk.com
       service: http://localhost:5002
     - service: http_status:404

 Then run:
   cloudflared.exe tunnel route dns mis-app dashboard.cred-desk.com
   Restart-Service cloudflared
--------------------------------------------------------------------
"@ -ForegroundColor Green
