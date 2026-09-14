"""
Serves the Tradebacked dashboard on localhost:5002.
Cloudflare tunnel proxies dashboard.cred-desk.com -> this server.
Run via NSSM: python C:\TBDashboard\serve.py
"""
import os
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler

WWW = r"C:\TBDashboard\www"
PORT = 5002

os.chdir(WWW)
print(f"Serving {WWW} on http://127.0.0.1:{PORT}")
sys.stdout.flush()

HTTPServer(("127.0.0.1", PORT), SimpleHTTPRequestHandler).serve_forever()
