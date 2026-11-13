import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DB_NAME = `reopen-bills-test-${process.pid}-${Date.now()}.db`;
const Database = (await import('../../lib/db/index.js')).default;
const db = Database.getInstance();
const { POST: pay } = await import('../../app/api/admin/pos/orders/[id]/pay/route.js');
const { POST: reopen } = await import('../../app/api/admin/bills/[id]/reopen/route.js');
const { DELETE: removeItem } = await import('../../app/api/admin/pos/orders/[id]/items/route.js');
const { openBusinessDay } = await import('../../lib/business-days.js');
const { nepalDateString } = await import('../../lib/report-dates.js');
const { ensureKotProSchema, getOrderWorkspace } = await import('../../lib/kot-service.js');

const token = 'reopen-admin';
let dayId;
const req = (url, method, body) => new Request(`http://localhost${url}`, {
  method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
});
const ctx = (id) => ({ params: Promise.resolve({ id: String(id) }) });
const json = async (response, status) => { const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data; };

async function servedOrder(number, lines) {
  const order = await db.run("INSERT INTO orders (order_number, status, business_day_id) VALUES (?, 'preparing', ?)", [number, dayId]);
  for (const [name, price, qty] of lines) {
    await db.run('INSERT INTO order_items (order_id, item_name, quantity, price, subtotal, sent_quantity, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [order.lastInsertRowid, name, qty, price, price * qty, qty, 'pending']);
  }
  return order.lastInsertRowid;
}

const payOrder = (orderId, total, body = {}) => pay(req(`/api/admin/pos/orders/${orderId}/pay`, 'POST', {
  idempotency_key: crypto.randomUUID(), service_charge_mode: 'amount', service_charge_value: 0, ...body,
  allocations: total > 0 ? [{ method: body.payment_method || 'cash', amount: total, cash_tendered: total }] : [],
}), ctx(orderId));

test.before(async () => {
  const admin = await db.get("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  await db.run("INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, datetime('now', '+1 day'))", [admin.id, token]);
  await db.run("UPDATE system_settings SET setting_value = '0' WHERE setting_key IN ('vat_percentage', 'service_charge_percentage')");
  dayId = (await openBusinessDay(db, { business_date: nepalDateString(), opening_cash: 50000 }, { ...admin, role: 'admin' })).id;
  await ensureKotProSchema(db);
});

test.after(async () => {
  await Database.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(path.join('databases', process.env.DB_NAME) + suffix); } catch { /* closed */ }
  }
});

test('resumed reopen keeps the original snapshot; refund goes back online, not out of the drawer', async () => {
  const orderId = await servedOrder('R-1', [['Momo', 300, 2], ['Tea', 100, 1]]);
  const first = await json(await payOrder(orderId, 700, { payment_method: 'online' }), 200);
  await json(await reopen(req(`/api/admin/bills/${first.bill_id}/reopen`, 'POST', { reason: 'wrong item' }), ctx(first.bill_id)), 201);

  const tea = await db.get("SELECT id FROM order_items WHERE order_id = ? AND item_name = 'Tea'", [orderId]);
  await json(await removeItem(req(`/api/admin/pos/orders/${orderId}/items?order_item_id=${tea.id}`, 'DELETE'), ctx(orderId)), 200);
  // Staff leave POS and reopen again: the second call only resumes.
  await json(await reopen(req(`/api/admin/bills/${first.bill_id}/reopen`, 'POST', { reason: 'continue' }), ctx(first.bill_id)), 201);

  const ws = await getOrderWorkspace(db, orderId);
  assert.equal(ws.already_paid, 700);

  const settled = await json(await payOrder(orderId, 0, { payment_method: 'online' }), 200);
  assert.equal(settled.receipt.refund_due, 100);
  assert.deepEqual(settled.receipt.items.map((i) => i.item_name).sort(), ['Momo', 'Tea']);
  assert.equal(settled.receipt.item_changes.removed.length, 1);

  const line = await db.get(`SELECT a.code FROM journal_entries j JOIN journal_lines l ON l.journal_id = j.id JOIN accounts a ON a.id = l.account_id
    WHERE j.source_type = 'refund' AND l.credit > 0`);
  assert.equal(line.code, '1020');
  const bill = await db.get('SELECT status, refunded_amount FROM bills WHERE id = ?', [first.bill_id]);
  assert.deepEqual([bill.status, Number(bill.refunded_amount)], ['paid', 100]);
});

test('an emptied reopened bill settles as a full refund instead of dead-ending', async () => {
  const orderId = await servedOrder('R-2', [['Thali', 500, 1]]);
  const first = await json(await payOrder(orderId, 500), 200);
  await json(await reopen(req(`/api/admin/bills/${first.bill_id}/reopen`, 'POST', { reason: 'guest left' }), ctx(first.bill_id)), 201);
  const thali = await db.get('SELECT id FROM order_items WHERE order_id = ?', [orderId]);
  await json(await removeItem(req(`/api/admin/pos/orders/${orderId}/items?order_item_id=${thali.id}`, 'DELETE'), ctx(orderId)), 200);

  const settled = await json(await payOrder(orderId, 0), 200);
  assert.equal(settled.receipt.refund_due, 500);
  const bill = await db.get('SELECT status, refunded_amount FROM bills WHERE id = ?', [first.bill_id]);
  assert.deepEqual([bill.status, Number(bill.refunded_amount)], ['refunded', 500]);
  assert.equal((await db.get('SELECT status FROM orders WHERE id = ?', [orderId])).status, 'completed');
});

test('a refund cannot be booked to credit', async () => {
  const orderId = await servedOrder('R-3', [['Lassi', 200, 2]]);
  const first = await json(await payOrder(orderId, 400), 200);
  await json(await reopen(req(`/api/admin/bills/${first.bill_id}/reopen`, 'POST', { reason: 'fix' }), ctx(first.bill_id)), 201);
  await json(await payOrder(orderId, 0, { payment_method: 'credit' }), 400);
});

test('an auto-offer that starts after the sale does not discount the reopened bill', async () => {
  const { ensurePromotionSchema } = await import('../../lib/promotions.js');
  const { POST: preview } = await import('../../app/api/admin/promotions/preview/route.js');
  const orderId = await servedOrder('R-4', [['Pizza', 1000, 1]]);
  const first = await json(await payOrder(orderId, 1000), 200);
  await ensurePromotionSchema(db);
  await db.run(`INSERT INTO promotions (name, discount_type, discount_value, scope, channels, auto_apply, is_active)
    VALUES ('Late offer', 'percent', 50, 'order', '["pos"]', 1, 1)`);
  await json(await reopen(req(`/api/admin/bills/${first.bill_id}/reopen`, 'POST', { reason: 'add drink' }), ctx(first.bill_id)), 201);
  assert.equal((await json(await preview(req('/api/admin/promotions/preview', 'POST', { order_id: orderId })), 200)).promotion, null);
  const settled = await json(await payOrder(orderId, 0), 200);
  assert.equal(settled.receipt.refund_due, 0);
  assert.equal(settled.receipt.grand_total, 1000);
  await db.run("UPDATE promotions SET is_active = 0 WHERE name = 'Late offer'");
});
