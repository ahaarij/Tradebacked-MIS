#!/usr/bin/env python3
"""
Pulls the current bytes of a shared SharePoint/OneDrive file via Microsoft Graph,
using app-only (client credentials) auth - no user sign-in, nothing to expire.

Usage (called by update.ps1 every 5 minutes):
    python graph_fetch.py -o "C:\\path\\to\\latest.xlsx"

Config: windows-deploy/graph_config.json (client_id, client_secret, tenant, share_url)
- not committed to git; copy graph_config.example.json and fill it in.

One-time tenant setup (already done for this deployment, kept here for reference):
  1. Register an app in Entra ID, add a client secret.
  2. API permissions -> Microsoft Graph -> Application permissions -> Sites.Selected
     -> grant admin consent.
  3. An admin with access to the file's site grants this app's "Sites.Selected"
     permission on that specific site (POST /sites/{id}/permissions, role "read").
     That's what scopes this app down to just that one site.
"""
import argparse
import base64
import json
import os
import sys

try:
    import msal
    import requests
except ImportError:
    sys.exit("Missing deps: pip install msal requests")

HERE        = os.path.dirname(os.path.abspath(__file__))
DEPLOY_DIR  = os.path.join(HERE, "..", "..", "windows-deploy")
CONFIG_PATH = os.path.join(DEPLOY_DIR, "graph_config.json")
GRAPH       = "https://graph.microsoft.com/v1.0"


def load_config():
    if not os.path.exists(CONFIG_PATH):
        sys.exit(
            f"Missing config: {CONFIG_PATH}\n"
            "Copy graph_config.example.json to graph_config.json and fill in "
            "client_id / client_secret / tenant / share_url."
        )
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


def get_app_only_token(cfg):
    app = msal.ConfidentialClientApplication(
        cfg["client_id"],
        authority=f"https://login.microsoftonline.com/{cfg['tenant']}",
        client_credential=cfg["client_secret"],
    )
    result = app.acquire_token_for_client(scopes=["https://graph.microsoft.com/.default"])
    if "access_token" not in result:
        sys.exit(f"Auth failed: {result.get('error_description', result)}")
    return result["access_token"]


def encode_share_url(url):
    b64 = base64.urlsafe_b64encode(url.encode("utf-8")).decode("utf-8").rstrip("=")
    return "u!" + b64


def fetch(cfg, token, out_path):
    share_id = encode_share_url(cfg["share_url"])
    headers = {"Authorization": f"Bearer {token}"}

    meta = requests.get(f"{GRAPH}/shares/{share_id}/driveItem", headers=headers, timeout=30)
    if meta.status_code != 200:
        sys.exit(f"Graph metadata request failed ({meta.status_code}): {meta.text}")
    name = meta.json().get("name", "workbook.xlsx")

    content = requests.get(f"{GRAPH}/shares/{share_id}/driveItem/content", headers=headers, timeout=120)
    if content.status_code != 200:
        sys.exit(f"Graph download failed ({content.status_code}): {content.text}")

    dest = out_path or name
    os.makedirs(os.path.dirname(os.path.abspath(dest)), exist_ok=True)
    with open(dest, "wb") as f:
        f.write(content.content)
    print(f"Downloaded '{name}' ({len(content.content) / 1024:.0f} KB) -> {dest}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-o", "--out", help="output file path for the downloaded workbook")
    args = ap.parse_args()

    cfg = load_config()
    token = get_app_only_token(cfg)
    fetch(cfg, token, args.out)
