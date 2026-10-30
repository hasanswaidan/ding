// Zero-dependency Web Push sender (RFC 8030 + RFC 8291 aes128gcm + RFC 8292 VAPID).
// Works with Chrome/Android (FCM), Firefox (Mozilla autopush) and Safari/iOS 16.4+ (Apple web push).
'use strict';
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (str) => Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// ---- VAPID keys (generated once, stored on disk) ----
function loadOrCreateVapid(file) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.publicKey && saved.privateKey) return saved;
  } catch (_) { /* first run */ }
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const keys = { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
  fs.writeFileSync(file, JSON.stringify(keys, null, 2));
  return keys;
}

function vapidPrivateKeyObject(vapid) {
  const pub = fromB64u(vapid.publicKey); // 0x04 || X || Y
  return crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: vapid.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: 'jwk',
  });
}

function vapidAuthHeader(endpoint, vapid, subject) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const unsigned = `${header}.${claims}`;
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key: vapidPrivateKeyObject(vapid), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64u(sig)}, k=${vapid.publicKey}`;
}

// ---- Payload encryption, RFC 8291 ----
function encrypt(payload, p256dh, auth) {
  const uaPublic = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  const as = crypto.createECDH('prime256v1');
  as.generateKeys();
  const asPublic = as.getPublicKey();
  const ecdhSecret = as.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const plaintext = Buffer.concat([Buffer.from(payload), Buffer.from([2])]); // 0x02 = last record
  const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// Sends one notification. Resolves {statusCode}; 404/410 mean the subscription is gone.
function sendNotification(subscription, payload, { vapid, subject, ttl = 600, urgency = 'high' }) {
  return new Promise((resolve, reject) => {
    const body = encrypt(typeof payload === 'string' ? payload : JSON.stringify(payload), subscription.keys.p256dh, subscription.keys.auth);
    const url = new URL(subscription.endpoint);
    const req = https.request({
      method: 'POST', hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'Content-Length': body.length,
        TTL: String(ttl),
        Urgency: urgency,
        Authorization: vapidAuthHeader(subscription.endpoint, vapid, subject),
      },
      timeout: 10000,
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ statusCode: res.statusCode }));
    });
    req.on('timeout', () => req.destroy(new Error('push timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

module.exports = { loadOrCreateVapid, sendNotification, encrypt, vapidAuthHeader, b64u, fromB64u };
