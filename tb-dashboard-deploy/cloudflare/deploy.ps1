<#
  Publish the dashboard to Cloudflare Pages from Windows. Protect it with Cloudflare Access first.
    .\cloudflare\deploy.ps1 setup                first run: creates the project with a blank placeholder
    .\cloudflare\deploy.ps1 publish              publishes site\index.html
    .\cloudflare\deploy.ps1 publish D:\MIS.xlsx  rebuilds from the workbook, then publishes
  Needs Node.js 18+ and, for rebuilding, Python 3 with openpyxl (py -m pip install openpyxl).
#>
param([Parameter(Mandatory = $true)][ValidateSet('setup', 'publish')][string]$Mode, [string]$Workbook,
      [string]$Project = 'tb-mis')
$ErrorActionPreference = 'Stop'
$Pkg  = Split-Path -Parent $PSScriptRoot
$Dist = Join-Path $env:TEMP ("tb-mis-" + [guid]::NewGuid())
New-Item -ItemType Directory $Dist | Out-Null
try {
  if ($Mode -eq 'setup') {
    npx --yes wrangler pages project create $Project --production-branch main
    if ($LASTEXITCODE -ne 0) { Write-Host '(project may already exist - continuing)' }
    Copy-Item "$Pkg\cloudflare\placeholder\index.html" $Dist
  } else {
    $ans = Read-Host "Is Cloudflare Access protecting $Project.pages.dev AND *.$Project.pages.dev? (yes/no)"
    if ($ans -ne 'yes') { Write-Host 'Set up Cloudflare Access first (DEPLOY.md, option C step 3). Nothing was published.'; exit 1 }
    if ($Workbook) { py "$Pkg\build\build_dashboard.py" $Workbook -o "$Dist\index.html"; if ($LASTEXITCODE -ne 0) { throw 'Build failed' } }
    else { Copy-Item "$Pkg\site\index.html" $Dist }
    Copy-Item "$Pkg\site\xlsx.full.min.js", "$Pkg\site\robots.txt" $Dist
  }
  Copy-Item "$Pkg\cloudflare\_headers" $Dist
  npx --yes wrangler pages deploy $Dist --project-name $Project --branch main --commit-dirty=true
} finally { Remove-Item $Dist -Recurse -Force -ErrorAction SilentlyContinue }
