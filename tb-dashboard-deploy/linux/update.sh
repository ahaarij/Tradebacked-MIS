#!/usr/bin/env bash
# Rebuild and publish the Tradebacked dashboard.
#   update.sh                    use the newest .xlsx/.xlsm uploaded to the inbox (skips if unchanged)
#   update.sh path/to/MIS.xlsx   build from a specific workbook
#   update.sh --force            rebuild even if the workbook hasn't changed
set -euo pipefail

APP=${TB_APP:-/opt/tb-dashboard}
WEBROOT=${TB_WEBROOT:-/var/www/tb-dashboard}
INBOX=${TB_INBOX:-/srv/tb-dashboard/inbox}
STAMP="$APP/.last_source.sha256"
ts() { date '+%F %T'; }

FORCE=0; SRC=""
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,5p' "$0"; exit 0 ;;
    *) SRC="$a" ;;
  esac
done

# Newest workbook by upload time (ctime), ignoring Excel lock files (~$...)
if [ -z "$SRC" ]; then
  SRC=$(find "$INBOX" -maxdepth 1 -type f \( -iname '*.xlsx' -o -iname '*.xlsm' \) ! -name '~$*' \
          -printf '%C@ %p\n' 2>/dev/null | sort -nr | head -n1 | cut -d' ' -f2- || true)
fi
[ -n "$SRC" ] || { echo "$(ts) no workbook found in $INBOX"; exit 0; }
[ -f "$SRC" ] || { echo "$(ts) file not found: $SRC" >&2; exit 1; }

# Don't pick up a file that is still being uploaded
s1=$(stat -c %s "$SRC"); sleep "${TB_SETTLE:-5}"; s2=$(stat -c %s "$SRC")
[ "$s1" = "$s2" ] || { echo "$(ts) $(basename "$SRC") is still uploading; will retry"; exit 0; }

HASH=$(sha256sum "$SRC" | cut -d' ' -f1)
if [ $FORCE -eq 0 ] && [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$HASH" ]; then
  exit 0   # already published this exact file
fi

# Build to a hidden temp file, then swap it in, so users never see a half-written page
TMP=$(mktemp "$WEBROOT/.build.XXXXXX")
if python3 "$APP/build_dashboard.py" "$SRC" -o "$TMP" 2> >(grep -v -e 'UserWarning' -e 'warn(msg)' >&2); then
  chmod 644 "$TMP"
  mv -f "$TMP" "$WEBROOT/index.html"
  echo "$HASH" > "$STAMP"
  echo "$(ts) published dashboard from $(basename "$SRC")"
else
  rm -f "$TMP"
  echo "$(ts) build FAILED for $(basename "$SRC"); the previous dashboard is still online" >&2
  exit 1
fi
