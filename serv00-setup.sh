#!/bin/sh
# ═══════════════════════════════════════════════════════════════════
# FLR-3 — نصب‌کنندهٔ رلهٔ خودی فلش روی serv00 (v2 · راند P871)
#
# چیزهایی که این اسکریپت خودش انجام می‌دهد:
#   ۱) دانلود رلهٔ فلش (relay.mjs) از گیت‌هاب
#   ۲) ساخت لودر Passenger (app.js) — سازگار با ESM بدون هیچ دردسر
#   ۳) ری‌استارت سایت
#   ۴) نگهدارندهٔ همیشگی (cron هر ۵ دقیقه — سرویس خالی را نمی‌کشد)
#   ۵) تست سلامت تا وقتی «FLR-3 ok» ببیند
#
# پیش‌نیاز (از پنل، یک‌بار):
#   WWW Websites → + Add new website → Advanced settings →
#   Type: Node.js · Domain: <user>.serv00.net · بعد گواهی Let's Encrypt از تب SSL
#
# اجرا (یک خط):
#   sh serv00-setup.sh <user>.serv00.net
# ═══════════════════════════════════════════════════════════════════
set -e
DOM="${1:-}"
if [ -z "$DOM" ]; then
  echo "✗ استفاده: sh serv00-setup.sh <user>.serv00.net"
  exit 1
fi

# ─── محل درست اپ روی serv00: domains/<dom>/public_nodejs ───
APPDIR="$HOME/domains/$DOM/public_nodejs"
if [ ! -d "$APPDIR" ]; then
  if [ -d "$HOME/domains/$DOM" ]; then
    mkdir -p "$APPDIR"
    echo "✓ پوشهٔ public_nodejs ساخته شد"
  else
    echo "✗ دامنهٔ $DOM پیدا نشد."
    echo "  اول از پنل: WWW Websites → + Add new website → Advanced settings → Type: Node.js → Domain: $DOM"
    exit 1
  fi
fi
cd "$APPDIR"

echo "── ۱) دانلود رلهٔ فلش ──"
rm -f relay.mjs app.js
if command -v fetch >/dev/null 2>&1; then
  fetch -q -o relay.mjs https://raw.githubusercontent.com/Mohamad-1385/FLR-3/main/flr3-node.mjs
else
  curl -fsSL -o relay.mjs https://raw.githubusercontent.com/Mohamad-1385/FLR-3/main/flr3-node.mjs
fi
[ -s relay.mjs ] || { echo "✗ دانلود نشد"; exit 1; }
echo "  ✓ relay.mjs ($(wc -c < relay.mjs) بایت)"

echo "── ۲) لودر Passenger ──"
cat > app.js << 'LOADER'
// FLR-3 — لودر Passenger (این فایل CJS می‌ماند؛ رلهٔ اصلی relay.mjs است)
const { pathToFileURL } = require("url");
const path = require("path");
import(pathToFileURL(path.join(__dirname, "relay.mjs")).href).catch((e) => {
  console.error("[FLR-3] boot fail:", e && e.message);
  process.exit(1);
});
LOADER
printf '{"name":"flr3-relay","private":true,"version":"1.0.0"}\n' > package.json
echo "  ✓ app.js + package.json"

echo "── ۳) ری‌استارت سایت ──"
devil www restart "$DOM" 2>/dev/null || devil www update "$DOM" 2>/dev/null || true

echo "── ۴) نگهدارندهٔ همیشگی (هر ۵ دقیقه) ──"
CRONLINE="*/5 * * * * curl -fsS https://$DOM/ping >/dev/null 2>&1 || fetch -q -o /dev/null https://$DOM/ping 2>/dev/null # FLR3-KEEPALIVE-$DOM"
(crontab -l 2>/dev/null | grep -v "FLR3-KEEPALIVE-$DOM"; echo "$CRONLINE") | crontab -
echo "  ✓ نصب شد"

echo "── ۵) تست سلامت (اولین باز شدن چند ثانیه طول می‌کشد) ──"
sleep 4
OK=""
i=1
while [ $i -le 8 ]; do
  if command -v curl >/dev/null 2>&1; then
    R=$(curl -fsS --max-time 10 "https://$DOM/health" 2>/dev/null || true)
  else
    R=$(fetch -q -o - "https://$DOM/health" 2>/dev/null || true)
  fi
  if [ "$R" = "FLR-3 ok" ]; then OK=1; break; fi
  sleep 5
  i=$((i + 1))
done
if [ -z "$OK" ]; then
  echo ""
  echo "✗ هنوز سلامت نمی‌دهد. دو چیز را چک کن:"
  echo "   ۱) گواهی SSL: پنل → WWW Websites → روی دامنه → SSL → New certificate (Let's Encrypt)"
  echo "   ۲) بعد از ۱۰ دقیقه دوباره همین اسکریپت را اجرا کن (DNS تازه‌ساختهٔ دامنه طول می‌کشد)"
  exit 1
fi
echo "  ✓ https://$DOM/health → FLR-3 ok"

echo ""
echo "════════════════════════════════════════════"
echo "   نصب کامل شد — رلهٔ خودی فلش زنده است!"
echo "════════════════════════════════════════════"
echo ""
echo "نشانی رلهٔ تو:  https://$DOM"
echo ""
echo "گام آخر — ثبت در شبکهٔ فلش:"
echo "  این نشانی را در فلش‌کلاد (داشبورد فلش) تست کن و پیامش را بفرست:"
echo "  https://mohamad-1385.github.io/FLR-3/"
echo ""
echo "به محض ثبت، همهٔ اپ‌های فلش ظرف ۱۰ دقیقه به سرور خودِ تو وصل می‌شوند."
