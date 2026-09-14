#!/bin/bash
# Run the dashboard locally at http://localhost:5002
cd "$(dirname "$0")/tb-dashboard-deploy/site"
echo "Dashboard running at http://localhost:5002"
python3 -m http.server 5002
