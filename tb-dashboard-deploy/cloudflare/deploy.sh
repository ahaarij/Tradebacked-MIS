#!/usr/bin/env bash
# Publish the dashboard to Cloudflare Pages. Protect it with Cloudflare Access before publishing real data.
#   ./cloudflare/deploy.sh setup              first run: creates the project with a blank placeholder page
#   ./cloudflare/deploy.sh publish            publishes site/index.html
#   ./cloudflare/deploy.sh publish MIS.xlsx   rebuilds from the workbook, then publishes
# Needs Node.js 18+ (for npx wrangler) and, for rebuilding, Python 3 with openpyxl.
set -euo pipefail
PROJECT=${TB_CF_PROJECT:-tb-mis}
PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE=${1:-}; WB=${2:-}
DIST=$(mktemp -d); trap 'rm -rf "$DIST"' EXIT

case "$MODE" in
  setup)
    npx --yes wrangler pages project create "$PROJECT" --production-branch main || echo "(project may already exist - continuing)"
    cp "$PKG/cloudflare/placeholder/index.html" "$DIST/"
    ;;
  publish)
    if [ "${TB_CF_CONFIRM:-}" != "yes" ]; then
      read -r -p "Is Cloudflare Access protecting $PROJECT.pages.dev AND *.$PROJECT.pages.dev? (yes/no) " ans
      [ "$ans" = "yes" ] || { echo "Set up Cloudflare Access first (DEPLOY.md, option C step 3). Nothing was published."; exit 1; }
    fi
    if [ -n "$WB" ]; then python3 "$PKG/build/build_dashboard.py" "$WB" -o "$DIST/index.html"
    else cp "$PKG/site/index.html" "$DIST/"; fi
    cp "$PKG/site/xlsx.full.min.js" "$PKG/site/robots.txt" "$DIST/"
    ;;
  *) sed -n '2,6p' "$0"; exit 1 ;;
esac
cp "$PKG/cloudflare/_headers" "$DIST/"
npx --yes wrangler pages deploy "$DIST" --project-name "$PROJECT" --branch main --commit-dirty=true
