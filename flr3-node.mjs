// ═══════════════════════════════════════════════════════════════════════
// FLR-3 — «رلهٔ خودی فلش» نسخهٔ پلتفرم‌مستقل (P870 — پایان بنِ لحظه‌ای کلادفلر)
//
// تک‌فایل · بدون هیچ وابستگی (Node ≥ 16) · اجرا روی هر جا:
//   · serv00 (رایگان — پشت Passenger/nginx با گواهی LE)  ← مسیر اصلی
//   · هر VPS / کامپیوتر / Render / Koyeb (env-driven)
//
// پروتکل‌ها (سازگار ۱:۱ با FLR-2d اثبات‌شده):
//   ① SMF بومی — SFM-mux چندجریانه روی یک WSS (هندشیک "SFM" + فریم‌ها)
//   ② VLESS-over-WS (سازگار FLR-1 — فالبک per-connection)
// خروجی (نردبان رلهٔ عمومی SNI — اثبات زندهٔ P870 از سرور غیر-CF):
//   مقاصد کلادفلری → رلهٔ GB → رلهٔ US → رلهٔ DE → رلهٔ FR → مستقیم
//   گوگل/تلگرام/جمینای و غیر-CF → مستقیم (اروپا — هرگز ایران)
//   UDP:53 → DoH واقعی
// بوت‌استرپ: BOOT_URLS (اختیاری) → لیست رله‌های خروجی از راه دور قابل‌تعویض
// کنترل: /health /stats /dbg /diag /ping · /boot.json?key=<UUID> (برای اپ)
// ═══════════════════════════════════════════════════════════════════════
import http from "node:http";
import https from "node:https";
import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";

// ─── پیکربندی (env — همه قابل‌ بازتنظیم) ───
const CFG = {
  UUID: (process.env.FLR_UUID || "1d0b7ee8-0691-40bd-8b05-ca2d02cf43a3").toLowerCase(),
  SMF_PATH: process.env.FLR_SMF_PATH || "/s2-c7a4df682646",
  VLESS_PATH: process.env.FLR_VLESS_PATH || "/f1-4b872aecdf",
  PORT: Number(process.env.PORT || 3000),
  HOST: process.env.HOST || "", // خالی = listen(port) — سازگار با Passenger (serv00) و همه‌جا
  TLS_CERT: process.env.FLR_TLS_CERT || "",
  TLS_KEY: process.env.FLR_TLS_KEY || "",
  // رله‌های خروجی (base64 — همان الگوی زندهٔ FLR-2d)
  EXITS_B64: (process.env.FLR_EXITS_B64 ||
    "cHJveHlpcC5nYi5jbWxpdXNzc3MubmV0OjQ0Mw==" + "," +  // proxyip.gb.cmliussss.net:443
    "cHJveHlpcC51cy5jbWxpdXNzc3MubmV0OjQ0Mw==" + "," +  // proxyip.us.cmliussss.net:443
    "cHJveHlpcC5kZS5jbWxpdXNzc3MubmV0OjQ0Mw==" + "," +  // proxyip.de.cmliussss.net:443
    "cHJveHlpcC5mci5jbWxpdXNzc3MubmV0OjQ0Mw=="),         // proxyip.fr.cmliussss.net:443
  BOOT_URLS: (process.env.FLR_BOOT_URLS || "").split(",").map((s) => s.trim()).filter(Boolean),
  BOOT_KEY: process.env.FLR_BOOT_KEY || "",
  DIAL_MS: Number(process.env.FLR_DIAL_MS || 8000),
};

// ─── وضعیت ───
const STAT = { smfStreams: 0, smfSessions: 0, vlessStreams: 0, bootAt: 0, bootSrc: "builtin", started: Date.now() };

// ═══ HTTP(S) کمکی (Node 16-سازگار — بدون fetch) ═══
function httpReq(urlStr, { method = "GET", headers = {}, body = null, timeoutMs = 6000 } = {}) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const mod = u.protocol === "http:" ? http : https;
      const req = mod.request(u, { method, headers, timeout: timeoutMs }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
        res.on("error", reject);
      });
      req.on("timeout", () => { req.destroy(new Error("timeout")); });
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    } catch (e) { reject(e); }
  });
}

// ═══ رنج‌های IPv4 کلادفلر (رسمی) + DoH ═══
const CF_RANGE_PAIRS = (() => {
  const cidrs = [
    "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
    "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
    "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
    "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  ];
  const toLong = (ip) => { const p = ip.split(".").map(Number); return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0; };
  return cidrs.map((c) => {
    const [netw, bits] = c.split("/");
    const base = toLong(netw);
    const size = 2 ** (32 - Number(bits));
    return [base, (base + size - 1) >>> 0];
  });
})();
function ipToLong(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}
function isIpV4(s) { return /^\d{1,3}(\.\d{1,3}){3}$/.test(s); }
function ipInCf(ip) {
  const n = ipToLong(ip);
  if (n === null) return false;
  for (const [a, b] of CF_RANGE_PAIRS) if (n >= a && n <= b) return true;
  return false;
}

const DOH_CACHE = new Map(); // host -> {ips, ts} (۱۰ دقیقه)
async function resolveA(host) {
  if (isIpV4(host)) return [host];
  const hit = DOH_CACHE.get(host);
  if (hit && Date.now() - hit.ts < 600000) return hit.ips;
  let ips = [];
  for (const doh of ["cloudflare-dns.com/dns-query", "dns.google/resolve"]) {
    try {
      const r = await httpReq(`https://${doh}?name=${encodeURIComponent(host)}&type=A`, { headers: { accept: "application/dns-json" } });
      if (r.status === 200) {
        const j = JSON.parse(r.buf.toString("utf8"));
        ips = ((j.Answer || []).filter((a) => a.type === 1).map((a) => a.data)).filter(isIpV4);
        if (ips.length) break;
      }
    } catch (e) {}
  }
  if (ips.length) {
    DOH_CACHE.set(host, { ips, ts: Date.now() });
    if (DOH_CACHE.size > 400) DOH_CACHE.clear();
  }
  return ips;
}
async function rawDnsResolve(q) {
  for (const s of ["https://cloudflare-dns.com/dns-query", "https://dns.google/dns-query"]) {
    try {
      const r = await httpReq(s, { method: "POST", headers: { "content-type": "application/dns-message" }, body: q });
      if (r.status === 200 && r.buf.length) return r.buf;
    } catch (e) {}
  }
  return null;
}

// ═══ نردبان خروجی: GB → US → DE → FR → مستقیم (قابل‌تعویض ریموت) ═══
let EXITS = CFG.EXITS_B64.split(",").map((b) => {
  const raw = Buffer.from(b, "base64").toString("utf8").trim();
  const i = raw.lastIndexOf(":");
  return { name: raw.slice(0, i), host: raw.slice(0, i), port: Number(raw.slice(i + 1)) || 443 };
});
const missAt = new Map();
function hopOk(name) { return Date.now() - (missAt.get(name) || 0) > 120000; }

async function fetchBootstrap() {
  for (const url of CFG.BOOT_URLS) {
    try {
      const r = await httpReq(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now(), { headers: { accept: "application/json" } });
      if (r.status !== 200) continue;
      const j = JSON.parse(r.buf.toString("utf8"));
      if (Array.isArray(j.exits) && j.exits.length) {
        const next = [];
        for (const e of j.exits) {
          if (!e || !e.host) continue;
          next.push({ name: e.name || e.host, host: e.host, port: Number(e.port) || 443 });
        }
        if (next.length) { EXITS = next; STAT.bootAt = Date.now(); STAT.bootSrc = url.split("/")[2] || url; return true; }
      }
    } catch (e) {}
  }
  return false;
}

async function isCfDest(host, port) {
  try {
    if (isIpV4(host)) return ipInCf(host) || host === "1.1.1.1" || host === "1.0.0.1";
    if ([443, 80, 2052, 2053, 2082, 2083, 2086, 2087, 2095, 2096, 8080, 8443, 8880].includes(port)) {
      const ips = await resolveA(host);
      return ips.some(ipInCf);
    }
    return false;
  } catch (e) { return false; }
}

// اتصال TCP با تایم‌اوت
function tcpConnect(host, port, timeoutMs = CFG.DIAL_MS) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const t = setTimeout(() => { sock.destroy(); reject(new Error("dial-timeout")); }, timeoutMs);
    sock.once("connect", () => { clearTimeout(t); resolve(sock); });
    sock.once("error", (e) => { clearTimeout(t); reject(e); });
  });
}

async function routeOut(host, port) {
  const cf = await isCfDest(host, port);
  if (cf && [443, 2053, 2083, 2087, 2096, 8443].includes(port)) {
    for (const hop of EXITS) {
      if (!hopOk(hop.name)) continue;
      try {
        const s = await tcpConnect(hop.host, hop.port);
        return { sock: s, via: hop.name };
      } catch (e) { missAt.set(hop.name, Date.now()); }
    }
  }
  const s = await tcpConnect(host, port);
  return { sock: s, via: cf ? "cf-direct" : "direct" };
}

// ═════════════ WebSocket سرور — RFC6455 دست‌ساز (بدون وابستگی) ═════════════
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

class WsConn {
  constructor(socket) {
    this.sock = socket;
    this.alive = true;
    this.closed = false;
    this.onMessage = null; // (chunk: Buffer, isText: bool) => void
    this.onClose = null;   // () => void
    this._frag = null;     // بافر تجمیع فریم‌های تکه‌تکه
    this._bufs = [];
    this._bufLen = 0;
    this._pausedSrcs = new Set();
    this._idleTimer = null;
    socket.setNoDelay(true);
    socket.on("data", (d) => this._onData(d));
    socket.on("error", () => this._teardown());
    socket.on("close", () => this._teardown());
    socket.on("drain", () => this._resumePaused());
    this._armIdle();
  }
  _armIdle() {
    clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => { this._teardown(); }, 600000); // ۱۰ دقیقه بی‌حرکتی
  }
  _teardown() {
    if (this.closed) return;
    this.closed = true; this.alive = false;
    clearTimeout(this._idleTimer);
    for (const s of this._pausedSrcs) { try { s.resume(); } catch (e) {} }
    this._pausedSrcs.clear();
    try { this.sock.destroy(); } catch (e) {}
    if (this.onClose) { try { this.onClose(); } catch (e) {} }
  }
  _resumePaused() {
    for (const s of this._pausedSrcs) { try { s.resume(); } catch (e) {} }
    this._pausedSrcs.clear();
  }
  _onData(d) {
    if (this.closed) return;
    this._armIdle();
    this._bufs.push(d);
    this._bufLen += d.length;
    if (this._bufLen > (1 << 22)) { this._teardown(); return; } // ۴MB پشت‌هم بدون مصرف = خرابی
    this._parse();
  }
  _take(n) {
    // n بایت از جلوی بافر — فقط وقتی کافی هست صدا زده می‌شود
    const out = Buffer.alloc(n);
    let off = 0;
    while (off < n) {
      const b = this._bufs[0];
      const need = n - off;
      if (b.length <= need) { b.copy(out, off); off += b.length; this._bufs.shift(); }
      else { b.copy(out, off, 0, need); this._bufs[0] = b.subarray(need); off += need; }
    }
    this._bufLen -= n;
    return out;
  }
  _parse() {
    for (;;) {
      if (this._bufLen < 2) return;
      const peek = this._bufs[0];
      const b0 = peek[0], b1 = peek.length > 1 ? peek[1] : this._bufs[1][0];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      const len7 = b1 & 0x7f;
      let hdr = 2, len = len7;
      if (len7 === 126) { if (this._bufLen < 4) return; const h = this._peekAt(2, 2); len = h.readUInt16BE(0); hdr = 4; }
      else if (len7 === 127) { if (this._bufLen < 10) return; const h = this._peekAt(2, 8); len = Number(h.readBigUInt64BE(0)); hdr = 10; }
      if (len > (1 << 21)) { this._teardown(); return; } // ۲MB سقف فریم
      const maskLen = masked ? 4 : 0;
      if (this._bufLen < hdr + maskLen + len) return;
      this._take(hdr);
      const mask = masked ? this._take(4) : null;
      let payload = this._take(len);
      if (mask) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      // کنترلی‌ها
      if (opcode === 0x8) { this._sendFrame(0x8, payload.subarray(0, 2)); this._teardown(); return; }
      if (opcode === 0x9) { this._sendFrame(0xA, payload); continue; }
      if (opcode === 0xA) { continue; }
      // داده‌ای‌ها (۰=ادامه، ۱=متن، ۲=باینری)
      if (opcode === 0x1 || opcode === 0x2) {
        this._frag = opcode === 0x1 ? { text: true, buf: payload } : { text: false, buf: payload };
      } else if (opcode === 0x0 && this._frag) {
        this._frag.buf = this._frag.buf.length ? Buffer.concat([this._frag.buf, payload]) : payload;
      } else { continue; }
      if (fin) {
        const msg = this._frag; this._frag = null;
        if (this.onMessage) { try { this.onMessage(msg.buf, msg.text); } catch (e) {} }
      }
    }
  }
  _peekAt(off, n) { // فقط برای هدر — مقدار کافی در بافر هست
    const out = Buffer.alloc(n);
    let done = 0, bi = 0, skip = off;
    while (done < n) {
      let b = this._bufs[bi];
      if (skip >= b.length) { skip -= b.length; bi++; continue; }
      const take = Math.min(n - done, b.length - skip);
      b.copy(out, done, skip, skip + take);
      done += take; skip = 0; bi++;
    }
    return out;
  }
  _sendFrame(opcode, payload) {
    if (this.closed) return;
    const len = payload.length;
    let hdr;
    if (len < 126) { hdr = Buffer.from([0x80 | opcode, len]); }
    else if (len < 65536) { hdr = Buffer.alloc(4); hdr[0] = 0x80 | opcode; hdr[1] = 126; hdr.writeUInt16BE(len, 2); }
    else { hdr = Buffer.alloc(10); hdr[0] = 0x80 | opcode; hdr[1] = 127; hdr.writeBigUInt64BE(BigInt(len), 2); }
    this.sock.write(hdr);
    this.sock.write(payload);
  }
  get pendingBytes() { return this.sock.writableLength || 0; }
  send(payload) { // باینری
    if (this.closed) return false;
    this._sendFrame(0x2, payload);
    if (this.pendingBytes > 4 * 1024 * 1024) return false; // سیگنال توقف منبع
    return true;
  }
  pauseSrc(srcSock) { this._pausedSrcs.add(srcSock); try { srcSock.pause(); } catch (e) {} }
  close() { this._teardown(); }
}

function acceptUpgrade(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key) { try { socket.destroy(); } catch (e) {} return null; }
  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  const head = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n";
  socket.write(head);
  return new WsConn(socket);
}

// ═════════════ بلوک SMF (عین FLR-2d — قرارداد سیمی یکسان) ═════════════
const F_DATA = 0x01, F_OPEN = 0x02, F_CLOSE = 0x04;
const NET_TCP = 1, NET_UDP = 2;
const SMF_ERR = { OK: 0, DIAL_FAIL: 1, UNSUPPORTED: 2, LANE_CLOSED: 4, TIMEOUT: 5 };
function smfFrame(sid, flags, payload) {
  const h = new Uint8Array(5 + payload.length);
  h[0] = (sid >> 8) & 255; h[1] = sid & 255;
  h[2] = flags;
  h[3] = (payload.length >> 8) & 255; h[4] = payload.length & 255;
  h.set(payload, 5);
  return h;
}
function smfIsHandshake(b) { return b && b.length >= 5 && b[0] === 0x53 && b[1] === 0x46 && b[2] === 0x4d; }
function smfDecoder() {
  const st = { mem: new Uint8Array(0) };
  st.push = (chunk) => {
    const m = new Uint8Array(st.mem.length + chunk.length);
    m.set(st.mem, 0); m.set(chunk, st.mem.length);
    st.mem = m;
    const frames = [];
    for (;;) {
      if (st.mem.length < 5) break;
      const sid = (st.mem[0] << 8) | st.mem[1];
      const flags = st.mem[2];
      const len = (st.mem[3] << 8) | st.mem[4];
      if (st.mem.length < 5 + len) break;
      frames.push({ sid, flags, data: st.mem.subarray(5, 5 + len) });
      st.mem = st.mem.subarray(5 + len);
    }
    return frames;
  };
  return st;
}

// پمپ سوکت → WS با فشار-پسین — P870-fix: چانک‌های >۶۵۵۳۵ بایت باید تکه شوند
// (طول فریم SMF ۱۶بیتی است — چانک ۶۴KBیِ Node سرِ مرز خرابش می‌کند)
function pumpSockToWs(sock, ws, sid) {
  sock.on("data", (d) => {
    let off = 0;
    while (off < d.length) {
      const piece = d.subarray(off, off + 60000);
      const ok = ws.send(smfFrame(sid, F_DATA, piece));
      if (!ok) { ws.pauseSrc(sock); break; } // توقف تا drain
      off += piece.length;
    }
  });
  sock.on("error", () => {});
}

async function handleSmfTunnel(ws) {
  STAT.smfSessions++;
  const dec = smfDecoder();
  const streams = new Map();
  const early = new Map();
  let sawHs = false;

  const send = (frame) => { if (!ws.closed) { try { ws.send(frame); } catch (e) {} } };
  const closeStream = (sid, reason) => {
    const st = streams.get(sid);
    if (st) {
      streams.delete(sid);
      STAT.smfStreams--;
      if (st.sock) { try { st.sock.destroy(); } catch (e) {} }
    }
    send(smfFrame(sid, F_CLOSE, new Uint8Array([reason & 255])));
  };
  const flushEarly = async (sid, st) => {
    const pend = early.get(sid);
    early.delete(sid);
    if (!pend || !pend.length) return true;
    for (const c of pend) {
      const ok = await new Promise((r) => {
        let done = false;
        const fin = (v) => { if (!done) { done = true; r(v); } };
        const t = setTimeout(() => fin(false), 5000);
        try {
          st.sock.write(c, () => { clearTimeout(t); fin(true); });
          st.sock.once("error", () => { clearTimeout(t); fin(false); });
          st.sock.once("close", () => { clearTimeout(t); fin(false); });
        } catch (e) { clearTimeout(t); fin(false); }
      });
      if (!ok) return false;
    }
    return true;
  };

  const onOpen = async (sid, d) => {
    const netw = d[0];
    const port = (d[1] << 8) | d[2];
    const atyp = d[3];
    let host = "", o = 4;
    try {
      if (atyp === 1) { host = `${d[o]}.${d[o+1]}.${d[o+2]}.${d[o+3]}`; o += 4; }
      else if (atyp === 2) { const dl = d[o]; o++; host = new TextDecoder().decode(d.subarray(o, o + dl)); o += dl; }
      else if (atyp === 3) {
        const g = (i) => d[o + i].toString(16).padStart(2, "0");
        host = `${g(0)}${g(1)}:${g(2)}${g(3)}:${g(4)}${g(5)}:${g(6)}${g(7)}:${g(8)}${g(9)}:${g(10)}${g(11)}:${g(12)}${g(13)}:${g(14)}${g(15)}`; o += 16;
      } else return closeStream(sid, SMF_ERR.UNSUPPORTED);
    } catch (e) { return closeStream(sid, SMF_ERR.UNSUPPORTED); }

    if (netw === NET_UDP) {
      if (port === 53) {
        streams.set(sid, { udp: true, dns: true });
        STAT.smfStreams++;
        send(smfFrame(sid, F_DATA, new Uint8Array([0])));
        const pend = early.get(sid);
        if (pend) { for (const q of pend) { if (q && q.length > 12) {
          const ans = await rawDnsResolve(q);
          if (streams.has(sid) && ans) send(smfFrame(sid, F_DATA, ans));
        } } early.delete(sid); }
        return;
      }
      return closeStream(sid, SMF_ERR.UNSUPPORTED);
    }
    if (netw !== NET_TCP) return closeStream(sid, SMF_ERR.UNSUPPORTED);

    let out;
    try { out = await routeOut(host, port); }
    catch (e) { return closeStream(sid, SMF_ERR.DIAL_FAIL); }
    const st = { sock: out.sock, via: out.via, wq: Promise.resolve() };
    streams.set(sid, st);
    STAT.smfStreams++;
    send(smfFrame(sid, F_DATA, new Uint8Array([0])));
    pumpSockToWs(out.sock, ws, sid);
    out.sock.on("close", () => { if (streams.has(sid)) closeStream(sid, SMF_ERR.OK); });
    const ok = await flushEarly(sid, st);
    if (!ok && streams.has(sid)) closeStream(sid, SMF_ERR.DIAL_FAIL);
  };

  ws.onClose = () => {
    for (const sid of [...streams.keys()]) {
      const st = streams.get(sid);
      if (st && st.sock) { try { st.sock.destroy(); } catch (e) {} }
    }
    STAT.smfStreams -= streams.size; // P870-fix: نشتی شمارنده (closeStream ندیدیم)
    streams.clear();
    STAT.smfSessions--;
  };
  ws.onMessage = async (data) => {
    if (!data.length) return;
    if (!sawHs) {
      sawHs = true;
      if (smfIsHandshake(data)) return;
      ws.close();
      return;
    }
    const frames = dec.push(data);
    for (const f of frames) {
      if (f.flags & F_OPEN) { early.set(f.sid, []); await onOpen(f.sid, f.data); continue; }
      const st = streams.get(f.sid);
      if ((f.flags & F_DATA) && !st && early.has(f.sid)) { early.get(f.sid).push(f.data); continue; }
      if (f.flags & F_CLOSE) { if (st) closeStream(f.sid, SMF_ERR.OK); early.delete(f.sid); continue; }
      if (!st) continue;
      if (f.flags & F_DATA) {
        if (st.dns) {
          if (f.data.length > 12) { const ans = await rawDnsResolve(f.data); if (streams.has(f.sid) && ans) send(smfFrame(f.sid, F_DATA, ans)); }
          continue;
        }
        // نوشتن سریال (حفظ ترتیب) روی سوکت
        st.wq = st.wq.then(() => new Promise((r) => {
          if (streams.get(f.sid) !== st) return r();
          try { st.sock.write(f.data, () => r()); } catch (e) { r(); }
        }));
      }
    }
  };
}

// ═════════════ پارسر VLESS (عین قرارداد کلاینت موتور) ═════════════
const HEX = [];
for (let i = 0; i < 256; i++) HEX.push(i.toString(16).padStart(2, "0"));
function bytesToUuid(b) {
  const h = []; for (const x of b) h.push(HEX[x]);
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
function parseVless(buf) {
  try {
    if (buf.length < 24 || buf[0] !== 0x00) return null;
    const uuid = bytesToUuid(buf.subarray(1, 17));
    const alen = buf[17];
    let off = 18 + alen;
    if (buf.length < off + 4) return null;
    const cmd = buf[off]; off++;
    if (cmd !== 0x01) return null;
    const port = (buf[off] << 8) | buf[off + 1]; off += 2;
    const atyp = buf[off]; off++;
    let host = "";
    if (atyp === 0x01) { host = `${buf[off]}.${buf[off+1]}.${buf[off+2]}.${buf[off+3]}`; off += 4; }
    else if (atyp === 0x02) { const dl = buf[off]; off++; host = new TextDecoder().decode(buf.subarray(off, off + dl)); off += dl; }
    else if (atyp === 0x03) { const g = (i) => buf[off + i].toString(16).padStart(2, "0"); host = `${g(0)}${g(1)}:${g(2)}${g(3)}:${g(4)}${g(5)}:${g(6)}${g(7)}:${g(8)}${g(9)}:${g(10)}${g(11)}:${g(12)}${g(13)}:${g(14)}${g(15)}`; off += 16; }
    else return null;
    return { uuid, host, port, payloadOff: off };
  } catch (e) { return null; }
}

async function handleVless(ws) {
  let opened = false, ready = false;
  let earlyV = [];
  let tcp = null;
  let writeQ = Promise.resolve();
  ws.onClose = () => { if (tcp) { try { tcp.destroy(); } catch (e) {} } };
  ws.onMessage = async (data) => {
    if (!data.length) return;
    if (!opened) {
      const v = parseVless(data);
      if (!v || v.uuid.toLowerCase() !== CFG.UUID) { ws.close(); return; }
      opened = true;
      let out;
      try { out = await routeOut(v.host, v.port); }
      catch (e) { ws.close(); return; }
      tcp = out.sock;
      STAT.vlessStreams++;
      ws.send(new Uint8Array([0, 0]));
      tcp.on("data", (d) => {
        const ok = ws.send(d);
        if (!ok) ws.pauseSrc(tcp);
      });
      tcp.on("error", () => {});
      tcp.on("close", () => { STAT.vlessStreams--; ws.close(); });
      ready = true;
      const payload = data.subarray(v.payloadOff);
      const w = (chunk) => new Promise((r) => { try { tcp.write(chunk, () => r(true)); } catch (e) { r(false); } });
      if (payload.length) await w(payload);
      if (earlyV.length) for (const d of earlyV) await w(d);
      earlyV = null;
      return;
    }
    if (!ready) { if (earlyV) earlyV.push(data); return; }
    writeQ = writeQ.then(() => new Promise((r) => {
      if (!tcp || ws.closed) return r();
      try { tcp.write(data, () => r()); } catch (e) { r(); }
    }));
  };
}

// ═════════════ ورودی HTTP + WS ═════════════
function textBody(req, res, code, body, type = "text/plain; charset=utf-8") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

async function handleRequest(req, res) {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/health") return textBody(req, res, 200, "FLR-3 ok");
    if (url.pathname === "/ping") return textBody(req, res, 200, "pong");
    if (url.pathname === "/stats") {
      return textBody(req, res, 200, JSON.stringify({
        relay: "FLR-3", smfStreams: STAT.smfStreams, smfSessions: STAT.smfSessions,
        vlessStreams: STAT.vlessStreams, exits: EXITS.map((e) => e.name),
        missAt: Object.fromEntries(missAt), bootAt: STAT.bootAt, bootSrc: STAT.bootSrc,
        upMs: Date.now() - STAT.started,
      }), "application/json");
    }
    if (url.pathname === "/dbg") {
      const host = url.searchParams.get("host") || "www.cloudflare.com";
      const port = Number(url.searchParams.get("port") || "80");
      const cf = await isCfDest(host, port);
      return textBody(req, res, 200, "cf=" + cf + " exits=" + EXITS.map((e) => e.name + (hopOk(e.name) ? ":ok" : ":miss")).join(" "));
    }
    if (url.pathname === "/diag") {
      const out = {};
      for (const hop of EXITS.slice(0, 3)) {
        const t0 = Date.now();
        try { const s = await tcpConnect(hop.host, hop.port, 6000); s.destroy(); out[hop.name] = "ok"; }
        catch (e) { out[hop.name] = "fail"; missAt.set(hop.name, Date.now()); }
        out[hop.name + "Ms"] = Date.now() - t0;
      }
      return textBody(req, res, 200, JSON.stringify(out), "application/json");
    }
    if (url.pathname === "/boot.json") {
      // فقط با کلید درست (UUID) — برای بوت‌استرپ اپ
      const key = (url.searchParams.get("key") || "").toLowerCase();
      if (key !== CFG.UUID) return textBody(req, res, 404, "not found");
      const host = req.headers.host || "";
      const hostname = host.split(":")[0];
      return textBody(req, res, 200, JSON.stringify({
        v: 1, relay: "FLR-3", at: Date.now(),
        entries: [{ host: hostname, port: Number((host.split(":")[1]) || "443"), path: CFG.SMF_PATH, vpath: CFG.VLESS_PATH }],
        exits: EXITS.map((e, i) => ({ host: e.host, port: e.port, cc: (e.name.match(/gb|us|de|fr|jp|sg|hk|kr/i) || [])[0] || String(i), prio: i + 1 })),
      }), "application/json");
    }
    return textBody(req, res, 404, "not found");
  } catch (e) {
    return textBody(req, res, 500, "flr3-err");
  }
}

function handleUpgrade(req, socket) {
  try {
    if ((req.headers.upgrade || "").toLowerCase() !== "websocket") { try { socket.destroy(); } catch (e) {} return; }
    const url = new URL(req.url, "http://x");
    // P870-fix: مسیر ناشناخته → ۴۰۴ قبل از آپگرید (نه قبول+بستن — موتور باید فوراً فالبک کند)
    if (url.pathname !== CFG.SMF_PATH && url.pathname !== CFG.VLESS_PATH) {
      socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    const ws = acceptUpgrade(req, socket);
    if (!ws) return;
    if (url.pathname === CFG.SMF_PATH) { handleSmfTunnel(ws).catch(() => { try { ws.close(); } catch (e) {} }); return; }
    handleVless(ws).catch(() => { try { ws.close(); } catch (e) {} });
  } catch (e) { try { socket.destroy(); } catch (e2) {} }
}

// ─── سرور (HTTP یا HTTPS بسته به env) ───
let server;
if (CFG.TLS_CERT && CFG.TLS_KEY) {
  server = https.createServer({ cert: fs.readFileSync(CFG.TLS_CERT), key: fs.readFileSync(CFG.TLS_KEY) }, handleRequest);
} else {
  server = http.createServer(handleRequest);
}
server.on("upgrade", handleUpgrade);
server.on("clientError", (err, socket) => { try { socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); } catch (e) {} });
server.listen(CFG.PORT, CFG.HOST || undefined, () => {
  console.log(`[FLR-3] listening ${CFG.HOST}:${CFG.PORT} tls=${!!(CFG.TLS_CERT && CFG.TLS_KEY)} smf=${CFG.SMF_PATH} vless=${CFG.VLESS_PATH} exits=[${EXITS.map((e) => e.name).join(",")}]`);
});

// ─── بوت‌استرپ دوره‌ای رله‌های خروجی ───
if (CFG.BOOT_URLS.length) {
  fetchBootstrap().then((ok) => console.log(`[FLR-3] bootstrap: ${ok ? STAT.bootSrc : "fallback-builtin"}`));
  setInterval(() => { fetchBootstrap().catch(() => {}); }, 600000);
}

process.on("uncaughtException", (e) => { console.error("[FLR-3] uncaught:", e && e.message); });
process.on("unhandledRejection", (e) => { console.error("[FLR-3] unhandled:", e && (e.message || e)); });
