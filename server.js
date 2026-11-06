// Ding — the customer's phone is the pager.
// Zero dependencies: run with `node server.js` (Node 18+).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const webpush = require('./webpush');

// ---------- Config ----------
const PORT = Number(process.env.PORT) || 3000;
const SHOP_NAME = process.env.SHOP_NAME || 'Our Café';
const STAFF_PIN = process.env.STAFF_PIN || '';            // empty = no PIN on the staff screen
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, ''); // e.g. https://ding.mycafe.com
const CONTACT = process.env.VAPID_SUBJECT || 'mailto:owner@example.com';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEMO = process.env.DEMO === '1';  // public demo: sample history, limits against spam
const KEEP_DONE_HOURS = 6;  // finished orders stay on the counter screen / customer cookie this long
const HISTORY_DAYS = 90;     // finished orders are kept this long for the dashboard
const CLAIM_MINUTES = 15;    // a counter-QR scan only picks up orders entered this recently

fs.mkdirSync(DATA_DIR, { recursive: true });
const vapid = webpush.loadOrCreateVapid(path.join(DATA_DIR, 'vapid.json'));
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const wa = require('./whatsapp').create({ file: path.join(DATA_DIR, 'whatsapp.json'), shop: SHOP_NAME });

// ---------- State ----------
// order: { id, number, note, items: [{ name, qty, details, price }], total, status: 'preparing'|'ready'|'collected'|'cancelled',
//          createdAt, readyAt, doneAt, scannedAt, claimedAt, alertsAt, subs: [pushSubscription], pings,
//          phone (international digits, deleted after KEEP_DONE_HOURS), hadPhone, whatsapp: { status, at, kind, error } }
let orders = [];
let nextNumber = 1;
try {
  const saved = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
  orders = saved.orders || [];
  nextNumber = saved.nextNumber || 1;
} catch (_) { /* first run */ }
const seeded = DEMO && !orders.length;
if (seeded) ({ orders, nextNumber } = require('./demo').seed());

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(ORDERS_FILE, JSON.stringify({ orders, nextNumber }), () => {});
  }, 200);
}
if (seeded) save();

function prune() {
  const now = Date.now();
  let changed = false;
  orders = orders.filter((o) => {
    if (o.doneAt && o.doneAt < now - HISTORY_DAYS * 86400e3) { changed = true; return false; }
    // History doesn't need phone push endpoints
    if (o.doneAt && o.doneAt < now - KEEP_DONE_HOURS * 3600e3 && o.subs && o.subs.length) { o.subs = []; changed = true; }
    // Customers' phone numbers are only kept while the order is fresh
    if (o.doneAt && o.doneAt < now - KEEP_DONE_HOURS * 3600e3 && o.phone) { o.phone = null; changed = true; }
    // Demo visitors rarely tidy up: close their orders after 2 hours
    if (DEMO && active(o) && o.createdAt < now - 2 * 3600e3) { o.status = 'collected'; o.doneAt = now; changed = true; }
    return true;
  });
  if (changed) save();
}
setInterval(prune, 10 * 60e3);

const newId = () => crypto.randomBytes(6).toString('base64url'); // unguessable per-order link
const active = (o) => o.status === 'preparing' || o.status === 'ready';
const recent = (o) => active(o) || (o.doneAt && o.doneAt > Date.now() - KEEP_DONE_HOURS * 3600e3);
const money = (n) => Math.round(n * 100) / 100;

function cleanItems(list) {
  return (Array.isArray(list) ? list : []).slice(0, 30).map((it) => {
    const price = Number(it && it.price);
    return {
      name: String((it && it.name) || '').trim().slice(0, 40),
      qty: Math.min(99, Math.max(1, Math.floor(Number(it && it.qty)) || 1)),
      details: String((it && it.details) || '').trim().slice(0, 80),
      price: it && it.price !== '' && it.price != null && Number.isFinite(price) && price >= 0 ? money(price) : null,
    };
  }).filter((it) => it.name);
}
const orderTotal = (items) => (items.some((it) => it.price != null) ? money(items.reduce((s, it) => s + (it.price || 0) * it.qty, 0)) : null);

// The order a counter-QR scan picks up: the newest one entered recently that no phone has taken yet
const claimable = () => orders
  .filter((o) => active(o) && !o.claimedAt && o.createdAt > Date.now() - CLAIM_MINUTES * 60e3)
  .sort((a, b) => b.createdAt - a.createdAt)[0];

// What the customer is allowed to see about their own order
function customerView(o) {
  const ahead = o.status === 'preparing'
    ? orders.filter((x) => x.status === 'preparing' && x.createdAt < o.createdAt).length
    : 0;
  return {
    id: o.id, number: o.number, note: o.note, items: o.items || [], total: o.total ?? null, status: o.status, shop: SHOP_NAME,
    createdAt: o.createdAt, readyAt: o.readyAt, ahead, pings: o.pings || 0,
    alerts: (o.subs || []).length > 0, now: Date.now(),
  };
}
// "+961 71 ••• 456": enough for staff to check, without showing the full number on a counter screen
const maskPhone = (p) => (p ? `+${p.slice(0, -6)} ••• ${p.slice(-3)}` : null);
function staffView(o) {
  const { subs, polledAt, phone, ...rest } = o;
  const polling = polledAt && Date.now() - polledAt < 8000 ? 1 : 0; // phone on the polling fallback
  return {
    ...rest, phone: maskPhone(phone),
    alerts: (subs || []).length > 0, watching: (customerStreams.get(o.id) || new Set()).size + polling,
  };
}
function staffSnapshot() {
  const next = claimable();
  return {
    orders: orders.filter((o) => o.status !== 'cancelled' && recent(o)).map(staffView),
    nextNumber, base: PUBLIC_URL, shop: SHOP_NAME, nextClaim: next ? next.id : null, whatsappMode: wa.mode,
  };
}

// ---------- WhatsApp ----------
async function notifyWhatsApp(o, kind) {
  if (!o.phone) return;
  o.whatsapp = { status: 'sending', kind, at: Date.now() };
  broadcast();
  const r = await wa.send(o.phone, wa.message(kind, o));
  o.whatsapp = { ...r, kind, at: Date.now() };
  save(); broadcast();
}
// Items used before, most popular first, with the last price used: quick buttons on the counter screen
function menu() {
  const byName = new Map();
  for (const o of [...orders].sort((a, b) => a.createdAt - b.createdAt)) {
    if (o.status === 'cancelled') continue;
    for (const it of o.items || []) {
      const key = it.name.toLowerCase();
      const m = byName.get(key) || { name: it.name, count: 0, price: null };
      m.count += it.qty; if (it.price != null) m.price = it.price;
      byName.set(key, m);
    }
  }
  return [...byName.values()].sort((a, b) => b.count - a.count).slice(0, 40);
}

// ---------- Live updates (Server-Sent Events) ----------
const customerStreams = new Map(); // orderId -> Set(res)
const staffStreams = new Set();

function sse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
}
const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

function broadcast() {
  for (const [id, set] of customerStreams) {
    const o = orders.find((x) => x.id === id);
    for (const res of set) send(res, 'order', o ? customerView(o) : { id, status: 'gone' });
  }
  const snap = staffSnapshot();
  for (const res of staffStreams) send(res, 'orders', snap);
}
setInterval(() => { // keep connections alive through proxies
  for (const set of customerStreams.values()) for (const r of set) r.write(': ka\n\n');
  for (const r of staffStreams) r.write(': ka\n\n');
}, 20000);

// ---------- Push ----------
async function pushTo(o, { title, body, tag }) {
  if (!o.subs || !o.subs.length) return;
  const url = `/o/${o.id}`;
  const payload = { title, body, url, tag: tag || `order-${o.id}` };
  const keep = [];
  await Promise.all(o.subs.map(async (sub) => {
    try {
      const { statusCode } = await webpush.sendNotification(sub, payload, { vapid, subject: CONTACT });
      if (statusCode !== 404 && statusCode !== 410) keep.push(sub);
      if (statusCode >= 400) console.warn(`push ${statusCode} for order ${o.number}`);
    } catch (e) {
      keep.push(sub);
      console.warn('push failed:', e.message);
    }
  }));
  o.subs = keep;
  save();
}

// ---------- HTTP helpers ----------
function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (_) { resolve({}); } });
  });
}
function staffOk(req, url) {
  if (!STAFF_PIN) return true;
  const given = req.headers['x-staff-pin'] || url.searchParams.get('pin') || '';
  return given.length === STAFF_PIN.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(STAFF_PIN));
}
function cookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : '';
}
function createOrder(number, note, items, phone = null) {
  number = String(number ?? '').trim().slice(0, 8) || String(nextNumber);
  if (/^\d+$/.test(number)) nextNumber = Math.max(nextNumber, Number(number) + 1);
  items = cleanItems(items);
  const o = {
    id: newId(), number, note: String(note || '').trim().slice(0, 80), items, total: orderTotal(items),
    status: 'preparing', createdAt: Date.now(), readyAt: null, doneAt: null, scannedAt: null, claimedAt: null, alertsAt: null,
    subs: [], pings: 0, phone, hadPhone: !!phone, whatsapp: null,
  };
  orders.push(o);
  save(); broadcast();
  return o;
}
function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0] || (req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.mp3': 'audio/mpeg', '.ico': 'image/x-icon',
};
function serveFile(res, file, extraHeaders = {}) {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) return json(res, 404, { error: 'Not found' });
  fs.readFile(full, (err, buf) => {
    if (err) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream', ...extraHeaders });
    res.end(buf);
  });
}
function renderPage(res, file, vars) {
  fs.readFile(path.join(PUBLIC_DIR, file), 'utf8', (err, html) => {
    if (err) return json(res, 500, { error: 'Missing page' });
    const out = html.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? '').replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(out);
  });
}

// ---------- Routes ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const m = (re) => p.match(re);
  let match;

  try {
    // ----- Pages -----
    if (req.method === 'GET' && (p === '/' || p === '/staff')) {
      return renderPage(res, 'staff.html', { shop: SHOP_NAME, needPin: STAFF_PIN ? '1' : '', demo: DEMO ? '1' : '' });
    }
    // The one QR code on the counter points here; a scan picks up the order the cashier just entered
    if (req.method === 'GET' && p === '/join') return renderPage(res, 'join.html', { shop: SHOP_NAME });
    if (req.method === 'GET' && p === '/dashboard') return renderPage(res, 'dashboard.html', { shop: SHOP_NAME, needPin: STAFF_PIN ? '1' : '' });
    if (req.method === 'GET' && (match = m(/^\/o\/([\w-]+)$/))) {
      const o = orders.find((x) => x.id === match[1]);
      return renderPage(res, 'customer.html', { shop: SHOP_NAME, id: match[1], number: o ? o.number : '' });
    }
    // Per-order manifest so "Add to Home Screen" on iPhone reopens this exact order
    if (req.method === 'GET' && (match = m(/^\/o\/([\w-]+)\/manifest\.webmanifest$/))) {
      const o = orders.find((x) => x.id === match[1]);
      const manifest = {
        name: o ? `Order ${o.number} · ${SHOP_NAME}` : SHOP_NAME,
        short_name: o ? `Order ${o.number}` : 'My order',
        start_url: `/o/${match[1]}`, scope: '/', id: `/o/${match[1]}`,
        display: 'standalone', background_color: '#EEF1EC', theme_color: '#14211B',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      };
      res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
      return res.end(JSON.stringify(manifest));
    }
    if (req.method === 'GET' && p === '/sw.js') return serveFile(res, 'sw.js', { 'Service-Worker-Allowed': '/', 'Cache-Control': 'no-cache' });
    if (req.method === 'GET' && /^\/[\w.-]+\.(css|js|svg|png|ico|mp3)$/.test(p)) return serveFile(res, p.slice(1));

    // ----- Customer API (anyone holding the order link) -----
    if (req.method === 'GET' && p === '/api/vapid') return json(res, 200, { publicKey: vapid.publicKey });

    if (req.method === 'POST' && p === '/api/join') {
      // Scanning again (or refreshing) returns the same open order instead of taking another one
      const prev = orders.find((x) => x.id === cookie(req, 'ding_order') && active(x));
      const o = prev || claimable();
      if (!o) return json(res, 202, { waiting: true }); // cashier hasn't entered it yet; the page retries
      if (!o.claimedAt) { o.claimedAt = Date.now(); save(); broadcast(); }
      const secure = baseUrl(req).startsWith('https') ? '; Secure' : '';
      res.setHeader('Set-Cookie', `ding_order=${o.id}; Path=/; Max-Age=${KEEP_DONE_HOURS * 3600}; HttpOnly; SameSite=Lax${secure}`);
      return json(res, 200, { id: o.id, number: o.number });
    }

    if (req.method === 'GET' && (match = m(/^\/api\/orders\/([\w-]+)\/events$/))) {
      const id = match[1];
      const o = orders.find((x) => x.id === id);
      sse(res);
      if (!o) { send(res, 'order', { id, status: 'gone' }); return res.end(); }
      if (!o.scannedAt) { o.scannedAt = Date.now(); save(); }
      if (!customerStreams.has(id)) customerStreams.set(id, new Set());
      customerStreams.get(id).add(res);
      send(res, 'order', customerView(o));
      broadcast(); // staff sees "customer is watching"
      req.on('close', () => {
        const set = customerStreams.get(id);
        if (set) { set.delete(res); if (!set.size) customerStreams.delete(id); }
        broadcast();
      });
      return;
    }
    if (req.method === 'GET' && (match = m(/^\/api\/orders\/([\w-]+)$/))) {
      const o = orders.find((x) => x.id === match[1]);
      if (o && url.searchParams.has('poll')) { // polling fallback for proxies that buffer SSE (e.g. trycloudflare)
        const first = !o.scannedAt;
        if (first) { o.scannedAt = Date.now(); save(); }
        o.polledAt = Date.now();
        if (first) broadcast();
      }
      return o ? json(res, 200, customerView(o)) : json(res, 404, { error: 'This order link has expired.' });
    }
    if (req.method === 'POST' && (match = m(/^\/api\/orders\/([\w-]+)\/subscribe$/))) {
      const o = orders.find((x) => x.id === match[1]);
      if (!o) return json(res, 404, { error: 'Order not found' });
      const sub = await readBody(req);
      if (!sub || !sub.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
        return json(res, 400, { error: 'Invalid subscription' });
      }
      o.subs = (o.subs || []).filter((s) => s.endpoint !== sub.endpoint).slice(-3);
      o.subs.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
      o.alertsAt = o.alertsAt || Date.now(); // kept for the dashboard after subs are dropped
      save(); broadcast();
      if (o.status === 'ready') pushTo(o, { title: `Order ${o.number} is ready`, body: `Come to the counter at ${SHOP_NAME}.` });
      return json(res, 200, { ok: true });
    }

    // ----- Staff API -----
    if (p.startsWith('/api/staff')) {
      if (!staffOk(req, url)) return json(res, 401, { error: 'Wrong staff PIN' });

      if (req.method === 'GET' && p === '/api/staff/events') {
        sse(res);
        staffStreams.add(res);
        // Without PUBLIC_URL the counter screen uses its own address for QR codes (works behind tunnels)
        send(res, 'orders', staffSnapshot());
        req.on('close', () => staffStreams.delete(res));
        return;
      }
      // Same snapshot as the SSE stream, for the polling fallback
      if (req.method === 'GET' && p === '/api/staff/orders') return json(res, 200, staffSnapshot());
      if (req.method === 'POST' && p === '/api/staff/orders') {
        const body = await readBody(req);
        if (DEMO && orders.filter(active).length >= 40) return json(res, 429, { error: 'Demo is full. Mark some orders collected first.' });
        let phone = null;
        if (String(body.phone || '').trim()) {
          phone = wa.normalize(body.phone);
          if (!wa.valid(phone)) return json(res, 400, { error: "That phone number doesn't look right. Check it and try again." });
        }
        const o = createOrder(body.number, body.note, body.items, phone);
        return json(res, 201, { order: staffView(o), url: `${baseUrl(req)}/o/${o.id}` });
      }
      if (req.method === 'POST' && (match = m(/^\/api\/staff\/orders\/([\w-]+)\/note$/))) {
        const o = orders.find((x) => x.id === match[1]);
        if (!o) return json(res, 404, { error: 'Order not found' });
        const body = await readBody(req);
        if ('note' in body) o.note = String(body.note || '').trim().slice(0, 80);
        if ('items' in body) { o.items = cleanItems(body.items); o.total = orderTotal(o.items); }
        save(); broadcast();
        return json(res, 200, { order: staffView(o) });
      }
      if (req.method === 'GET' && p === '/api/staff/menu') return json(res, 200, { items: menu() });
      // Dashboard: every order in the range, full details (no push endpoints)
      if (req.method === 'GET' && p === '/api/staff/history') {
        const days = Math.min(HISTORY_DAYS, Math.max(1, Number(url.searchParams.get('days')) || 1));
        const since = Number(url.searchParams.get('since')) || Date.now() - days * 86400e3;
        const list = orders.filter((o) => o.createdAt >= since)
          .map(({ subs, polledAt, phone, ...o }) => ({ ...o, alerts: !!o.alertsAt || (subs || []).length > 0 }));
        return json(res, 200, { orders: list, shop: SHOP_NAME, now: Date.now() });
      }
      if (req.method === 'POST' && (match = m(/^\/api\/staff\/orders\/([\w-]+)\/(ready|collected|cancel|reopen|ping)$/))) {
        const o = orders.find((x) => x.id === match[1]);
        if (!o) return json(res, 404, { error: 'Order not found' });
        const action = match[2];
        if (action === 'ready') {
          o.status = 'ready'; o.readyAt = Date.now();
          const what = (o.items || []).map((it) => `${it.qty > 1 ? it.qty + '× ' : ''}${it.name}`).join(', ');
          pushTo(o, { title: `Order ${o.number} is ready`, body: `${what ? what + '. ' : ''}Come to the counter at ${SHOP_NAME}.` });
          notifyWhatsApp(o, 'ready');
        } else if (action === 'ping') {
          o.pings = (o.pings || 0) + 1;
          pushTo(o, { title: `Reminder: order ${o.number} is waiting`, body: 'Your order is at the counter.', tag: `order-${o.id}-${o.pings}` });
          notifyWhatsApp(o, 'ping');
        } else if (action === 'collected') {
          o.status = 'collected'; o.doneAt = Date.now();
        } else if (action === 'cancel') {
          o.status = 'cancelled'; o.doneAt = Date.now();
        } else if (action === 'reopen') {
          o.status = 'preparing'; o.readyAt = null; o.doneAt = null;
        }
        save(); broadcast();
        return json(res, 200, { order: staffView(o) });
      }
      if (req.method === 'POST' && p === '/api/staff/reset-numbers') {
        nextNumber = 1; save(); broadcast();
        return json(res, 200, { nextNumber });
      }
    }

    json(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: 'Something went wrong on the server.' });
  }
});

server.listen(PORT, () => {
  console.log(`Ding is running: http://localhost:${PORT}  (staff screen)`);
  if (STAFF_PIN) console.log('Staff PIN is on.');
  console.log(wa.mode === 'live' ? 'WhatsApp messages: ON' : 'WhatsApp messages: test mode (logged here, not sent). Add data/whatsapp.json to send for real.');
  if (!PUBLIC_URL) console.log('Tip: set PUBLIC_URL to your https address so QR codes point to it.');
});
