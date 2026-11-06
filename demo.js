// Demo mode (DEMO=1): fills an empty store with two weeks of realistic café orders,
// so the dashboard has something to show on a public demo. Never used for a real shop.
'use strict';
const crypto = require('crypto');

const MENU = [
  { name: 'Flat white', price: 3.5, details: ['2 shots', '2 shots, oat milk', '1 shot', 'extra hot'], weight: 9 },
  { name: 'Latte', price: 3.8, details: ['oat milk', 'vanilla', '', 'decaf'], weight: 8 },
  { name: 'Cappuccino', price: 3.6, details: ['', 'extra foam', 'cinnamon'], weight: 6 },
  { name: 'Espresso', price: 2.4, details: ['', 'double'], weight: 4 },
  { name: 'Americano', price: 2.9, details: ['', 'with milk on the side'], weight: 5 },
  { name: 'Iced latte', price: 4.2, details: ['oat milk', 'caramel', ''], weight: 4 },
  { name: 'Matcha latte', price: 4.5, details: ['oat milk', ''], weight: 3 },
  { name: 'Croissant', price: 2.25, details: ['', 'warmed'], weight: 5 },
  { name: 'Banana bread', price: 3.2, details: [''], weight: 3 },
  { name: 'Chicken sandwich', price: 6.9, details: ['', 'no mayo'], weight: 3 },
];
// Relative order volume per hour of day: morning rush and a lunch bump
const HOURLY = { 7: 3, 8: 9, 9: 8, 10: 5, 11: 4, 12: 7, 13: 6, 14: 4, 15: 4, 16: 3, 17: 2, 18: 1 };

function seed(rand = Math.random) {
  const pick = (list, w = (x) => x.weight || 1) => {
    let r = rand() * list.reduce((s, x) => s + w(x), 0);
    for (const x of list) { r -= w(x); if (r <= 0) return x; }
    return list[list.length - 1];
  };
  const between = (a, b) => a + rand() * (b - a);
  const hours = Object.entries(HOURLY).map(([h, weight]) => ({ h: Number(h), weight }));
  const now = Date.now();
  const orders = [];
  let todayCount = 0;

  for (let d = 13; d >= 0; d--) {
    const day = new Date(now); day.setHours(0, 0, 0, 0); day.setDate(day.getDate() - d);
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    const count = Math.round(between(28, 46) * (weekend ? 1.25 : 1));
    const times = [];
    for (let i = 0; i < count; i++) {
      const t = day.getTime() + (pick(hours).h + rand()) * 3600e3;
      if (t < now - 20 * 60e3) times.push(t); // leave the last 20 minutes free for the visitor's own orders
    }
    times.sort((a, b) => a - b).forEach((createdAt, i) => {
      const items = [];
      const lines = rand() < 0.6 ? 1 : rand() < 0.75 ? 2 : 3;
      for (let l = 0; l < lines; l++) {
        const m = pick(MENU);
        if (items.some((it) => it.name === m.name)) continue;
        items.push({ name: m.name, qty: rand() < 0.85 ? 1 : 2, details: m.details[Math.floor(rand() * m.details.length)], price: m.price });
      }
      const cancelled = rand() < 0.03;
      const readyAt = createdAt + between(1.5, 7.5) * 60e3;
      const doneAt = cancelled ? createdAt + between(1, 4) * 60e3 : readyAt + between(0.3, 3.5) * 60e3;
      const viaWhatsApp = rand() < 0.55; // cashier typed their number
      const scanned = !viaWhatsApp && rand() < 0.7;
      orders.push({
        id: crypto.randomBytes(6).toString('base64url'), number: String(i + 1),
        note: rand() < 0.08 ? 'takeaway' : '', items,
        total: Math.round(items.reduce((s, it) => s + it.price * it.qty, 0) * 100) / 100,
        status: cancelled ? 'cancelled' : 'collected', createdAt,
        readyAt: cancelled ? null : readyAt, doneAt,
        scannedAt: scanned ? createdAt + 20e3 : null, claimedAt: scanned ? createdAt + 15e3 : null,
        alertsAt: scanned && rand() < 0.65 ? createdAt + 40e3 : null, subs: [], pings: 0,
        phone: null, hadPhone: viaWhatsApp,
        whatsapp: viaWhatsApp && !cancelled ? { status: 'sent', kind: 'ready', at: readyAt } : null,
      });
      if (d === 0) todayCount = i + 1;
    });
  }
  return { orders, nextNumber: todayCount + 1 };
}

module.exports = { seed };
