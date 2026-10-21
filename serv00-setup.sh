#!/bin/sh
# ═══════════════════════════════════════════════════════════════════
# FLR-3 — نصب رلهٔ خودی فلش روی serv00 (یک‌بار، ۳۰ ثانیه)
# اجرا: بعد از ساخت سایت Node.js از پنل، این اسکریپت را در SSH اجرا کن:
#   sh serv00-setup.sh <دامنهٔ سایت>
# مثال:
#   sh serv00-setup.sh mohamad.serv00.net
# ═══════════════════════════════════════════════════════════════════
set -e
DOM="${1:-}"
if [ -z "$DOM" ]; then
  echo "استفاده: sh serv00-setup.sh <user>.serv00.net"
  exit 1
fi
APPDIR="$HOME/domains/$DOM"
if [ ! -d "$APPDIR" ]; then
  echo "✗ پوشهٔ $APPDIR نیست — اول از پنل DevilWEB سایت Node.js با دامنهٔ $DOM بساز"
  exit 1
fi
cd "$APPDIR"
echo "── ۱) دانلود رله (flr3-node.mjs → app.js) ──"
if command -v fetch >/dev/null 2>&1; then
  fetch -q -o app.js https://raw.githubusercontent.com/Mohamad-1385/FLR-3/main/flr3-node.mjs
else
  curl -fsSL -o app.js https://raw.githubusercontent.com/Mohamad-1385/FLR-3/main/flr3-node.mjs
fi
[ -s app.js ] || { echo "✗ دانلود نشد"; exit 1; }
echo "  ✓ app.js ($(wc -c < app.js) بایت)"

echo "── ۲) ری‌استارت سایت (Passenger) ──"
devil www restart "$DOM" 2>/dev/null || devil www update "$DOM" 2>/dev/null || true
echo "  ✓ (اگر خط داد مهم نیست — درخواست بعدی سرد-شروع می‌شود)"

echo ""
echo "═══ تمام! حالا تست کن: ═══"
echo "  https://$DOM/health   → باید FLR-3 ok بدهد"
echo "  https://$DOM/ping     → pong"
echo ""
echo "بعد از تأیید سلامت، این نشانی را برای ثبت در بوت‌استرپ بفرست (ربات/ایدی)."
