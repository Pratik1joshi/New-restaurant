import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DB_NAME = `public-offers-test-${process.pid}-${Date.now()}.db`;
const Database = (await import('../../lib/db/index.js')).default;
const db = Database.getInstance();
const { getPublicWebsiteOffers } = await import('../../lib/public-offers.js');
const { POST: createPromotion } = await import('../../app/api/admin/promotions/route.js');
const { POST: createCombo } = await import('../../app/api/admin/combos/route.js');
const { POST: previewOffer } = await import('../../app/api/public/promotions/preview/route.js');
const { POST: placeOrder } = await import('../../app/api/public/orders/route.js');
const { recordPromotionRedemption } = await import('../../lib/promotions.js');
const { isPromotionScheduledNow, toNepalFormDateTime } = await import('../../lib/promotion-display.js');
const { openBusinessDay } = await import('../../lib/business-days.js');
const { nepalDateString } = await import('../../lib/report-dates.js');

const token = 'offers-admin';
const post = async (handler, url, body, status = 201) => {
  const res = await handler(new Request(`http://localhost${url}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-forwarded-for': `10.0.0.${Math.floor(Math.random() * 250)}` }, body: JSON.stringify(body) }));
  const data = await res.json();
  assert.equal(res.status, status, JSON.stringify(data));
  return data;
};
// 12:00 and 16:00 Nepal time on a Tuesday.
const tueNoon = new Date('2026-11-10T06:15:00Z');
const tueFour = new Date('2026-11-10T10:15:00Z');
const names = async (now) => (await getPublicWebsiteOffers({ now })).map((o) => o.name).sort();
let items;

test.before(async () => {
  const admin = await db.get("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  await db.run("INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, datetime('now', '+1 day'))", [admin.id, token]);
  items = await db.all('SELECT id, name, category_id, base_price FROM menu_items WHERE is_available = 1 ORDER BY id LIMIT 4');
  const all = ['pos', 'website', 'qr'];
  await post(createPromotion, '/api/admin/promotions', { name: 'Lunch', discount_type: 'percent', discount_value: 10, scope: 'order', daily_start_time: '11:00', daily_end_time: '15:00', channels: all, auto_apply: true });
  await post(createPromotion, '/api/admin/promotions', { name: 'Counter only', discount_type: 'fixed', discount_value: 5, scope: 'order', channels: ['pos'], auto_apply: true });
  await post(createPromotion, '/api/admin/promotions', { name: 'Weekend', discount_type: 'percent', discount_value: 5, scope: 'order', days_of_week: ['sat', 'sun'], channels: all, auto_apply: true });
  await post(createPromotion, '/api/admin/promotions', { name: 'Coded', code: 'SAVE50', discount_type: 'fixed', discount_value: 50, scope: 'order', channels: all });
  await post(createPromotion, '/api/admin/promotions', { name: 'One use', discount_type: 'fixed', discount_value: 1, scope: 'order', usage_limit: 1, channels: all, auto_apply: true });
  await post(createPromotion, '/api/admin/promotions', { name: 'Not redeemable', discount_type: 'fixed', discount_value: 1, scope: 'order', channels: all, auto_apply: false });
  const pair = [{ menu_item_id: items[0].id, quantity: 1 }, { menu_item_id: items[1].id, quantity: 1 }];
  await post(createCombo, '/api/admin/combos', { name: 'Web combo', category_id: items[0].category_id, price: 10, channels: all, components: pair });
  await post(createCombo, '/api/admin/combos', { name: 'POS combo', category_id: items[0].category_id, price: 10, channels: ['pos'], components: pair });
  await post(createCombo, '/api/admin/combos', { name: 'Paused combo', category_id: items[0].category_id, price: 10, channels: all, is_active: false, components: pair });
  await post(createCombo, '/api/admin/combos', { name: 'Broken combo', category_id: items[0].category_id, price: 10, channels: all, components: [{ menu_item_id: items[2].id, quantity: 1 }, { menu_item_id: items[3].id, quantity: 1 }] });
  await db.run('UPDATE menu_items SET is_available = 0 WHERE id = ?', [items[3].id]);
});

test.after(async () => {
  await Database.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(path.join('databases', process.env.DB_NAME) + suffix); } catch { /* closed */ }
  }
});

test('website shows only what checkout would honour right now', async () => {
  assert.deepEqual(await names(tueNoon), ['Coded', 'Lunch', 'One use', 'Web combo']);
  assert.deepEqual(await names(tueFour), ['Coded', 'One use', 'Web combo']);
  const promo = await db.get("SELECT id FROM promotions WHERE name = 'One use'");
  await recordPromotionRedemption(db, { promotion: { id: Number(promo.id), name: 'One use', discount: 1 }, channel: 'website' });
  assert.ok(!(await names(tueNoon)).includes('One use'));
  const lunch = (await getPublicWebsiteOffers({ now: tueNoon })).find((o) => o.name === 'Lunch');
  assert.deepEqual(lunch.conditions, ['11 AM – 3 PM', 'On your whole order']);
});

test('offer times are Nepal wall-clock regardless of server zone', () => {
  const promo = { starts_at: '2026-11-10T12:00', ends_at: '2026-11-10' };
  assert.equal(isPromotionScheduledNow(promo, new Date('2026-11-10T06:14:00Z')), false); // 11:59 NPT
  assert.equal(isPromotionScheduledNow(promo, new Date('2026-11-10T06:16:00Z')), true); // 12:01 NPT
  assert.equal(isPromotionScheduledNow(promo, new Date('2026-11-10T18:10:00Z')), true); // 23:55 NPT, same day
  assert.equal(toNepalFormDateTime('2026-11-10T06:15:00.000Z'), '2026-11-10T12:00');
});

test('website cart preview and the placed order agree on a coupon discount', async () => {
  await openBusinessDay(db, { business_date: nepalDateString(), opening_cash: 1000 }, { id: 1, role: 'admin' });
  const line = [{ menu_item_id: items[2].id, quantity: 2 }];
  const preview = await post(previewOffer, '/api/public/promotions/preview', { channel: 'website', coupon_code: 'SAVE50', items: line }, 200);
  assert.equal(preview.promotion.discount, 50);
  const order = await post(placeOrder, '/api/public/orders', {
    customer_name: 'Web Guest', customer_phone: '9800000001', order_type: 'takeaway', idempotency_key: crypto.randomUUID(), coupon_code: 'SAVE50', items: line,
  });
  assert.equal(Number(order.order.discount), 50);
  assert.equal(Number(order.order.grand_total), Number(items[2].base_price) * 2 - 50);
});
