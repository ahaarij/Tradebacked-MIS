# Hosting the Tradebacked MIS dashboard

The dashboard contains client names, owners and balances. Every option below puts it
behind a login. Don't upload `site/index.html` to any host without one.

| Option | Use it when | Login |
|---|---|---|
| **A. Linux server (Nginx)** | You have (or can rent) an Ubuntu/Debian server, including a UAE-hosted VPS | Username + password |
| **B. Windows Server (IIS)** | Your office runs Windows / Active Directory | Staff Windows accounts |
| **C. Cloudflare Pages** | You want it online in 10 minutes without a server (data held on Cloudflare's network) | One-time email code |

## What's in this folder

```
site/        ready-to-serve files: index.html (dashboard, 3rd Sep data), xlsx.full.min.js, robots.txt
build/       build_dashboard.py + src/ (dashboard source) - turns an MIS .xlsx into index.html
linux/       install.sh, update.sh, tb-dashboard.nginx.conf
windows/     install-iis.ps1, update.ps1, web.config.template
cloudflare/  deploy.sh, deploy.ps1, _headers, placeholder page
```

---

## A. Linux server (Ubuntu 22.04 / 24.04 or Debian 12)

**1. Point a domain at the server.** In your DNS, add an A record, e.g. `mis.yourcompany.com` → server IP.

**2. Copy this folder to the server** (from your PC):
```
scp -r tb-dashboard-deploy  youruser@SERVER_IP:~
```
(or upload it with WinSCP / FileZilla over SFTP).

**3. Run the installer:**
```
ssh youruser@SERVER_IP
cd ~/tb-dashboard-deploy
sudo bash linux/install.sh -d mis.yourcompany.com -u finance -e it@yourcompany.com
```
It asks for the password for the `finance` login, installs Nginx, sets up HTTPS (Let's Encrypt,
auto-renewing), and prints the address. Add `-a 203.0.113.10,10.0.0.0/8` to allow only your
office / VPN IPs.

**4. Daily refresh.** Upload the new MIS workbook into `/srv/tb-dashboard/inbox`. The
dashboard republishes itself within 15 minutes (only when the file actually changed). Uploads that
are still in progress, Excel lock files, and broken files are skipped. The last good dashboard stays online.
```
# let your SSH/SFTP user upload into the inbox (log out and back in afterwards)
sudo usermod -aG tbmis youruser

# upload from your PC
scp "Tradebacked MIS - 12th Sep.xlsx" youruser@SERVER_IP:/srv/tb-dashboard/inbox/

# or publish immediately instead of waiting
sudo /opt/tb-dashboard/update.sh
```

**Users**
```
sudo htpasswd -B /etc/nginx/.htpasswd-tb investor1     # add or change a password
sudo htpasswd -D /etc/nginx/.htpasswd-tb investor1     # remove
```

**Where things live:** web files `/var/www/tb-dashboard`, builder `/opt/tb-dashboard`,
inbox `/srv/tb-dashboard/inbox`, refresh log `/var/log/tb-dashboard.log`,
Nginx site `/etc/nginx/sites-available/tb-dashboard`.

---

## B. Windows Server with IIS (Active Directory login)

**1. Prepare:**
- Create (or pick) an AD group for dashboard users, e.g. `COMPANY\Finance-MIS`.
- Add a DNS record, e.g. `mis.company.local` → the server.
- Install Python 3 from python.org (tick "Add to PATH"). It is used for the automatic refresh.
- For HTTPS, import a certificate for the hostname into *Local Computer → Personal* and note its thumbprint.

**2. Copy this folder to the server** (e.g. `C:\Setup\tb-dashboard-deploy`).

**3. Run PowerShell as Administrator:**
```
cd C:\Setup\tb-dashboard-deploy
Set-ExecutionPolicy -Scope Process Bypass
.\windows\install-iis.ps1 -HostName mis.company.local -AllowedGroup "COMPANY\Finance-MIS" -CertThumbprint <THUMBPRINT>
```
Leave out `-CertThumbprint` for an HTTP-only internal test. Several groups:
`-AllowedGroup "COMPANY\Finance-MIS,COMPANY\Directors"`.

Staff on domain PCs open the address and are signed in automatically in Edge/Chrome. Anyone
else is asked for their Windows username and password.

**4. Daily refresh.** Copy the new MIS workbook into `C:\TBDashboard\inbox` (share the folder
with the finance team if convenient). A scheduled task publishes it within 15 minutes, or run
`C:\TBDashboard\update.ps1`. Log: `C:\TBDashboard\update.log`.

---

## C. Cloudflare Pages + Cloudflare Access (no server)

Needs a free Cloudflare account and Node.js 18+ on your PC.

**1. Log in:**  `npx wrangler login`

**2. Create the project with a blank placeholder** (no data is published yet):
```
bash cloudflare/deploy.sh setup          # Mac/Linux
.\cloudflare\deploy.ps1 setup            # Windows PowerShell
```

**3. Turn on the login (do this before step 4).** In the Cloudflare dashboard:
Zero Trust → Access → Applications → *Add an application* → **Self-hosted**
- Application domain: `tb-mis.pages.dev`, then add a second one: `*.tb-mis.pages.dev`
- Policy: Action **Allow**, Include **Emails** (list each person) or **Emails ending in** `@yourcompany.com`
- Save, then open `https://tb-mis.pages.dev` in a private window. You should see the Cloudflare sign-in page, not the placeholder.

**4. Publish the dashboard:**
```
bash cloudflare/deploy.sh publish "Tradebacked MIS - 12th Sep.xlsx"
.\cloudflare\deploy.ps1 publish "D:\MIS\Tradebacked MIS - 12th Sep.xlsx"
```
Run the same command each day with the new workbook. Leave out the workbook to publish `site/index.html` as it is.

---

## Refreshing without rebuilding

Any signed-in user can also press **Load updated MIS** on the dashboard and pick a newer
workbook. It is read inside their browser, nothing is uploaded, and it only changes their own view.
The Excel reader is hosted next to the page, so this works on offline intranets too.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Certificate request failed (A) | DNS record not pointing at the server yet, or port 80 blocked. Fix, then `sudo certbot --nginx -d DOMAIN --redirect` |
| `403 Forbidden` after login (A) | Your IP isn't in the `-a` allow-list. Re-run install.sh with the right list |
| `401.2` or repeated login prompts (B) | User isn't in the allowed AD group, or needs to sign out and back in after being added |
| `500.19` error (B) | IIS URL Authorization feature missing. Re-run install-iis.ps1 |
| Dashboard doesn't update | Check the log (A: `/var/log/tb-dashboard.log`, B: `C:\TBDashboard\update.log`). "build FAILED" means the workbook couldn't be read. Save it in Excel and upload again |
| Numbers look stale after an update | The workbook was saved by a tool other than Excel (no calculated values). Open and save it in Excel |
