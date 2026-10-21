# FLR-3 — رلهٔ خودی فلش (پلتفرم‌مستقل)

پایان وابستگی به کلادفلر: این رله **تک‌فایل و بدون هیچ وابستگی** است و روی هر جایی اجرا می‌شود — serv00 (رایگان)، هر VPS، یا هر هاست Node.js.

## چرا؟
کلادفلر ورکرهای پروکسی را لحظه‌ای بن می‌کند. FLR-3 روی **سرور خود شما** اجرا می‌شود:
- بدون اسکنر، بدون بنِ خودکار
- خروجی: مقاصد کلادفلری از دل رلهٔ GB (انگلیس) — بقیه مستقیم از سرور خودتان (اروپا)
- سازگار ۱:۱ با پروتکل بومی فلش (SMF-mux روی WSS) + فالبک VLESS

## راهنمای serv00 (رایگان — ۵ دقیقه، یک‌بار برای همیشه)

### ۱) ثبت‌نام
- برو به `serv00.com/register-account`
- کشور را **Iran** انتخاب کن (در لیست هست)، ایمیل خودت را بزن
- تأیید دستی: چند ساعت تا ۷۲ ساعت صبر کن (ایمیل تأیید می‌آید)

### ۲) ساخت سایت Node.js
بعد از دریافت ایمیل، وارد پنل `panel.serv00.com` شو (یا `sNN.serv00.com` که در ایمیل گفته):
- منوی **WWW Websites → Add New Website**
- Domain: `(یوزرنیم خودت).serv00.net` — اگر پنل دامنهٔ دیگری پیشنهاد داد همان را بزن
- **Type: Node.js**
- ذخیره کن

### ۳) گواهی رایگان TLS (Let's Encrypt)
- در همان صفحه سایتت → **SSL** → گواهی Let's Encrypt بساز (یک کلیک، رایگان)

### ۴) نصب رله (یک خط!)
در پنل SSH را باز کن (یا با Termux: `ssh user@sNN.serv00.com`) و بزن:

```sh
fetch -q -o ~/domains/<user>.serv00.net/app.js https://raw.githubusercontent.com/Mohamad-1385/FLR-3/main/flr3-node.mjs
```

یا کل اسکریپت نصب:

```sh
fetch -q -o /tmp/s.sh https://raw.githubusercontent.com/Mohamad-1385/FLR-3/main/serv00-setup.sh && sh /tmp/s.sh <user>.serv00.net
```

### ۵) تست
```
https://<user>.serv00.net/health  →  FLR-3 ok
https://<user>.serv00.net/ping    →  pong
```

### ۶) ثبت در اپ
نشانی `https://<user>.serv00.net` را بفرست تا در `bootstrap.json` با اولویت ۱ ثبت شود — از آن لحظه همهٔ اپ‌های فلش به‌جای ورکر کلادفلر به **سرور خودت** وصل می‌شوند.

## حالت پیشرفته (VPS / هاست دلخواه)

```sh
# بدون TLS (پشت nginx/پنل):
PORT=3000 node flr3-node.mjs

# با TLS مستقیم روی پورت 443:
FLR_TLS_CERT=/path/cert.pem FLR_TLS_KEY=/path/key.pem PORT=443 node flr3-node.mjs
```

متغیرها:
| متغیر | پیش‌فرض | توضیح |
|---|---|---|
| `PORT` | 3000 | پورت شنود (Passenger خودش می‌دهد) |
| `FLR_UUID` | (همان فلش) | UUID احراز VLESS |
| `FLR_SMF_PATH` | (همان فلش) | مسیر WS پروتکل SMF |
| `FLR_VLESS_PATH` | (همان فلش) | مسیر WS فالبک VLESS |
| `FLR_EXITS_B64` | رله‌های GB/US/DE/FR | نردبان خروجی (base64 با کاما) |
| `FLR_BOOT_URLS` | — | فهرست رله‌های خروجی از راه دور (JSON) |

## بنچمارک (P870)
- تخلخل خود کد رله (لوپ‌بک): **۱۸۶ Mbps**
- زنجیرهٔ کامل GB از دل رله: loc=GB / colo=LHR اثبات زنده
- mux چندجریانه + DoH + فالبک VLESS: همه ✓ (E2E = ۱۲/۱۲)
