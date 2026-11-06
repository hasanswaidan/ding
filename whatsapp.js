// WhatsApp sender for "your order is ready" messages, through any HTTP WhatsApp API
// (an ISP/provider gateway, Meta's Cloud API, etc.). Everything provider-specific lives in
// data/whatsapp.json, so no code changes are needed to switch providers.
//
// Without that file (or with "mode": "test") nothing is sent: messages are logged and the
// counter screen shows "WhatsApp (test)". See whatsapp.example.json for the format.
'use strict';
const fs = require('fs');

const DEFAULTS = {
  mode: 'test',                 // 'test' = log only, 'live' = really send
  countryCode: '',              // added to local numbers, e.g. "961" for Lebanon
  url: '',                      // provider endpoint; may contain {{phone}}, {{message}}, ...
  method: 'POST',
  headers: {},                  // e.g. { "Authorization": "Bearer YOUR_KEY" }
  bodyType: 'json',             // 'json' | 'form' | 'none' (everything in the URL)
  body: { phone: '{{phone}}', message: '{{message}}' },
  timeoutMs: 10000,
  messages: {
    ready: '☕ {{shop}}: your order {{number}} is ready! {{items}}Please come to the counter.',
    ping: '⏰ {{shop}}: reminder, your order {{number}} is waiting at the counter.',
  },
};

function load(file) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`whatsapp: can't read ${file}: ${e.message} (staying in test mode)`);
  }
  const merged = { ...DEFAULTS, ...cfg, messages: { ...DEFAULTS.messages, ...(cfg.messages || {}) } };
  if (merged.mode === 'live' && !merged.url) {
    console.warn('whatsapp: "mode" is "live" but "url" is empty, staying in test mode');
    merged.mode = 'test';
  }
  return merged;
}

// Turns what the cashier typed into international digits: "03 123 456" -> "9613123456" with countryCode 961
function normalizePhone(raw, countryCode = '') {
  let d = String(raw || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return d.slice(1).replace(/\D/g, '');
  d = d.replace(/\D/g, '');
  if (d.startsWith('00')) return d.slice(2);
  if (!countryCode || d.startsWith(countryCode) && d.length > 9) return d;
  if (d.startsWith('0')) return countryCode + d.slice(1);
  return d.length <= 9 ? countryCode + d : d;
}
const validPhone = (digits) => /^\d{8,15}$/.test(digits);

const fill = (s, vars, encode) => String(s).replace(/\{\{(\w+)\}\}/g, (_, k) => (encode ? encodeURIComponent(vars[k] ?? '') : String(vars[k] ?? '')));
function fillDeep(v, vars) {
  if (typeof v === 'string') return fill(v, vars);
  if (Array.isArray(v)) return v.map((x) => fillDeep(x, vars));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillDeep(x, vars)]));
  return v;
}

function create({ file, shop }) {
  let cfg = load(file);
  fs.watchFile(file, { interval: 3000 }, () => { cfg = load(file); console.log(`whatsapp: settings reloaded (${cfg.mode} mode)`); });

  function message(kind, o) {
    const items = (o.items || []).map((it) => `${it.qty > 1 ? it.qty + '× ' : ''}${it.name}`).join(', ');
    return fill(cfg.messages[kind] || '', { shop, number: o.number, items: items ? items + '. ' : '', note: o.note || '' }).trim();
  }

  // Resolves { status: 'sent'|'test'|'failed', error? }; never throws
  async function send(phone, text) {
    const vars = { phone, phonePlus: '+' + phone, message: text };
    if (cfg.mode !== 'live') {
      console.log(`whatsapp (test, not sent) to +${phone}: ${text}`);
      return { status: 'test' };
    }
    try {
      const headers = { ...fillDeep(cfg.headers, vars) };
      let body;
      if (cfg.bodyType === 'json') { body = JSON.stringify(fillDeep(cfg.body, vars)); headers['Content-Type'] ||= 'application/json'; }
      else if (cfg.bodyType === 'form') { body = new URLSearchParams(fillDeep(cfg.body, vars)).toString(); headers['Content-Type'] ||= 'application/x-www-form-urlencoded'; }
      const r = await fetch(fill(cfg.url, vars, true), { method: cfg.method, headers, body, signal: AbortSignal.timeout(cfg.timeoutMs) });
      const reply = (await r.text().catch(() => '')).slice(0, 300);
      if (!r.ok) {
        console.warn(`whatsapp: provider answered ${r.status} for +${phone}: ${reply}`);
        return { status: 'failed', error: `Provider error ${r.status}` };
      }
      return { status: 'sent' };
    } catch (e) {
      console.warn(`whatsapp: sending to +${phone} failed: ${e.message}`);
      return { status: 'failed', error: e.name === 'TimeoutError' ? 'Provider timed out' : 'Could not reach provider' };
    }
  }

  return {
    get mode() { return cfg.mode; },
    normalize: (raw) => normalizePhone(raw, cfg.countryCode),
    valid: validPhone,
    message,
    send,
  };
}

module.exports = { create, normalizePhone };
