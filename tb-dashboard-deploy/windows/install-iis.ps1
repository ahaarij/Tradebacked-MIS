<#
.SYNOPSIS
  Host the Tradebacked MIS dashboard on IIS, restricted to a Windows / Active Directory group.

.DESCRIPTION
  Installs IIS (static files, Windows Authentication, URL Authorization), creates the site,
  turns off anonymous access, limits access to -AllowedGroup, optionally binds an HTTPS
  certificate, and schedules a 15-minute refresh from C:\TBDashboard\inbox.

.EXAMPLE
  .\windows\install-iis.ps1 -HostName mis.company.local -AllowedGroup "COMPANY\Finance-MIS"

.EXAMPLE
  .\windows\install-iis.ps1 -HostName mis.company.com -AllowedGroup "COMPANY\Finance-MIS" -CertThumbprint 3A1B2C...

.NOTES
  Run in PowerShell as Administrator. Requires Python 3 for the auto-refresh (https://www.python.org).
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string]$HostName,
  [Parameter(Mandatory = $true)] [string]$AllowedGroup,
  [string]$CertThumbprint,
  [string]$SiteName = 'TB-MIS',
  [string]$WebRoot  = 'C:\inetpub\tb-dashboard',
  [string]$AppDir   = 'C:\TBDashboard',
  [string]$Python   = 'py',
  [switch]$NoScheduledTask
)

$ErrorActionPreference = 'Stop'
function Step([string]$m) { Write-Host "`n==> $m" -ForegroundColor Cyan }

$principal = New-Object Security.Principal.WindowsPrincipal ([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Please run this script in PowerShell opened with "Run as administrator".'
}
$Pkg = Split-Path -Parent $PSScriptRoot

# ---------------------------------------------------------------- IIS features
Step 'Installing IIS with Windows Authentication and URL Authorization'
if (Get-Command Install-WindowsFeature -ErrorAction SilentlyContinue) {
  Install-WindowsFeature Web-Server, Web-Static-Content, Web-Default-Doc, Web-Http-Errors, `
                         Web-Windows-Auth, Web-Url-Auth, Web-Mgmt-Console | Out-Null
} else {
  # Windows 10 / 11 (no Server Manager)
  Enable-WindowsOptionalFeature -Online -All -NoRestart -FeatureName `
    IIS-WebServerRole, IIS-WebServer, IIS-StaticContent, IIS-DefaultDocument, IIS-HttpErrors, `
    IIS-WindowsAuthentication, IIS-URLAuthorization, IIS-ManagementConsole | Out-Null
}
Import-Module WebAdministration

# ---------------------------------------------------------------- files
Step 'Copying dashboard files'
New-Item -ItemType Directory -Force -Path $WebRoot, $AppDir, "$AppDir\inbox", "$AppDir\build" | Out-Null
Copy-Item "$Pkg\site\index.html", "$Pkg\site\xlsx.full.min.js", "$Pkg\site\robots.txt" $WebRoot -Force
Copy-Item "$Pkg\build\*" "$AppDir\build" -Recurse -Force
Copy-Item "$PSScriptRoot\update.ps1" $AppDir -Force
@{ WebRoot = $WebRoot; Inbox = "$AppDir\inbox"; Python = $Python } |
  ConvertTo-Json | Set-Content "$AppDir\config.json" -Encoding UTF8

Step "Restricting access to $AllowedGroup"
$template = Get-Content "$PSScriptRoot\web.config.template" -Raw
$template.Replace('__ALLOWED_GROUP__', [Security.SecurityElement]::Escape($AllowedGroup)) |
  Set-Content "$WebRoot\web.config" -Encoding UTF8
# Static files are read with the signed-in user's identity, so the group needs read access on disk
foreach ($g in $AllowedGroup.Split(',')) { & icacls $WebRoot /grant "$($g.Trim()):(OI)(CI)RX" | Out-Null }
& icacls $WebRoot /grant "IIS_IUSRS:(OI)(CI)RX" | Out-Null

# ---------------------------------------------------------------- site
Step "Creating IIS site '$SiteName' for $HostName"
if (-not (Test-Path "IIS:\AppPools\$SiteName")) { New-WebAppPool -Name $SiteName | Out-Null }
Set-ItemProperty "IIS:\AppPools\$SiteName" -Name managedRuntimeVersion -Value ''
if (-not (Get-Website -Name $SiteName)) {
  New-Website -Name $SiteName -PhysicalPath $WebRoot -HostHeader $HostName -Port 80 -ApplicationPool $SiteName | Out-Null
} else {
  Set-ItemProperty "IIS:\Sites\$SiteName" -Name physicalPath -Value $WebRoot
}

$apphost = 'MACHINE/WEBROOT/APPHOST'
Set-WebConfigurationProperty -PSPath $apphost -Location $SiteName `
  -Filter 'system.webServer/security/authentication/anonymousAuthentication' -Name enabled -Value $false
Set-WebConfigurationProperty -PSPath $apphost -Location $SiteName `
  -Filter 'system.webServer/security/authentication/windowsAuthentication' -Name enabled -Value $true

if ($CertThumbprint) {
  Step 'Binding HTTPS certificate'
  $thumb = $CertThumbprint -replace '\s', ''
  if (-not (Test-Path "Cert:\LocalMachine\My\$thumb")) { throw "Certificate $thumb not found in LocalMachine\My." }
  if (-not (Get-WebBinding -Name $SiteName -Protocol https)) {
    New-WebBinding -Name $SiteName -Protocol https -Port 443 -HostHeader $HostName -SslFlags 1
  }
  (Get-WebBinding -Name $SiteName -Protocol https).AddSslCertificate($thumb, 'My')
  # Refuse plain HTTP for this site
  Set-WebConfigurationProperty -PSPath $apphost -Location $SiteName `
    -Filter 'system.webServer/security/access' -Name sslFlags -Value 'Ssl'
}
Start-Website -Name $SiteName

# ---------------------------------------------------------------- python + refresh task
Step 'Checking Python for the auto-refresh'
$pyOk = $false
try { & $Python -m pip install --quiet --disable-pip-version-check openpyxl; $pyOk = ($LASTEXITCODE -eq 0) } catch { }
if (-not $pyOk) {
  Write-Warning "Python was not found as '$Python'. Install Python 3, then run: py -m pip install openpyxl"
}

if (-not $NoScheduledTask) {
  Step 'Scheduling refresh every 15 minutes'
  $action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
             -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$AppDir\update.ps1`""
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
             -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
  Register-ScheduledTask -TaskName 'TB-MIS dashboard refresh' -Action $action -Trigger $trigger `
    -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
}

$scheme = if ($CertThumbprint) { 'https' } else { 'http' }
Write-Host @"

--------------------------------------------------------------------
 Tradebacked MIS dashboard is live

   Open:        ${scheme}://$HostName
   Access:      Windows sign-in, members of $AllowedGroup

   Refresh it:  copy the new MIS .xlsx into $AppDir\inbox
                (published within 15 minutes, or run: $AppDir\update.ps1)
   Log:         $AppDir\update.log
--------------------------------------------------------------------
"@ -ForegroundColor Green
if (-not $CertThumbprint) { Write-Warning 'Running without HTTPS. Bind a certificate (-CertThumbprint) before using it outside the office network.' }
