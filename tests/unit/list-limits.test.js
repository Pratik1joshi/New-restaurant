import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PosDatabase } from '../../lib/db/index.js';
import { ensureColumn } from '../../lib/db/schema-helpers.js';
import { OrderRepository } from '../../lib/db/repositories/orders.js';
import { buildReportRecordDetails } from '../../lib/report-record-details.js';
import { ensureAccountingSchema, journalList } from '../../lib/accounting.js';

const dbPath = path.join(os.tmpdir(), `list-limits-test-${process.pid}-${Date.now()}.db`);
const db = new PosDatabase(dbPath);

test.after(() => {
  try { db.close(); } catch { /* already closed */ }
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(`${dbPath}${suffix}`); } catch { /* already gone */ }
  }
});

const addOrder = async (orderNumber, { status = 'pending', waiterId = null } = {}) => {
  const order = await db.run(
    `INSERT INTO orders (order_number, status, order_type, waiter_id) VALUES (?, ?, 'dine_in', ?)`,
    [orderNumber, status, waiterId]
  );
  await db.run(
    `INSERT INTO order_items (order_id, item_name, quantity, price, subtotal, status) VALUES (?, 'Momo', 1, 100, 100, 'pending')`,
    [order.lastInsertRowid]
  );
};

test('the kitchen board keeps the newest ticket when more than 40 orders are open', async () => {
  for (let i = 1; i <= 45; i += 1) await addOrder(`KB-${i}`);
  // Not `new OrderRepository()`: its constructor opens the app's real database.
  const repo = Object.create(OrderRepository.prototype);
  repo.db = db;
  const { orders } = await repo.getKitchenBoard();
  const numbers = orders.map((o) => o.order_number);
  assert.ok(numbers.includes('KB-45'), 'newest order fell off the kitchen board');
  assert.ok(numbers.includes('KB-1'));
});

test('employee totals count every order, not just the 100 rows on screen', async () => {
  await ensureColumn(db, 'bills', 'payment_status', "TEXT DEFAULT 'unpaid'");
  const user = await db.run(
    `INSERT INTO users (username, password_hash, full_name, role) VALUES ('limit-waiter', 'x', 'Limit Waiter', 'waiter')`
  );
  const waiterId = user.lastInsertRowid;
  for (let i = 1; i <= 105; i += 1) await addOrder(`EMP-${i}`, { status: 'completed', waiterId });

  const details = await buildReportRecordDetails(db, { tab: 'employees', row: { _record_id: waiterId } });
  assert.equal(details.summary.find((f) => f.label === 'Orders served').value, 105);
  assert.equal(details.sections.find((s) => s.title === 'Latest orders served').rows.length, 100);
});

test('the journal lists every entry in the range, with its lines', async () => {
  await ensureAccountingSchema(db);
  const account = await db.get(`SELECT id FROM accounts ORDER BY id LIMIT 1`);
  for (let i = 1; i <= 105; i += 1) {
    const entry = await db.run(
      `INSERT INTO journal_entries (entry_date, memo, source_type, source_id) VALUES ('2020-01-15', ?, 'limit_test', ?)`,
      [`Entry ${i}`, i]
    );
    await db.run(
      `INSERT INTO journal_lines (journal_id, account_id, debit, credit) VALUES (?, ?, 10, 0)`,
      [entry.lastInsertRowid, account.id]
    );
  }
  const journals = await journalList(db, { from: '2020-01-01', to: '2020-01-31', source_type: 'limit_test' });
  assert.equal(journals.length, 105);
  assert.ok(journals.every((j) => j.lines.length === 1));
});
