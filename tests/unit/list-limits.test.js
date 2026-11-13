import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PosDatabase } from '../../lib/db/index.js';
import { ensureColumn } from '../../lib/db/schema-helpers.js';
import { OrderRepository } from '../../lib/db/repositories/orders.js';
import { buildReportRecordDetails } from '../../lib/report-record-details.js';
import { ensureAccountingSchema, generalLedger, journalList } from '../../lib/accounting.js';
import { customerLedgerHistoryPage, customerReceivablesPage } from '../../lib/accounting-receivables.js';
import { supplierLedgerHistoryPage, supplierPayablesPage } from '../../lib/accounting-suppliers.js';
import { ensureSplitPaymentSchema } from '../../lib/split-payments.js';
import { listSuppliers } from '../../lib/purchases.js';
import { ensureLedgerSchema } from '../../lib/inventory-ledger.js';

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

test('general ledger and journal page through every entry, with totals and search across all pages', async () => {
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
  const range = { from: '2020-01-01', to: '2020-01-31' };

  const lastJournals = await journalList(db, { ...range, source_type: 'limit_test', page: 3, pageSize: 50 });
  assert.equal(lastJournals.pagination.total, 105);
  assert.equal(lastJournals.rows.length, 5);
  assert.equal(lastJournals.summary.debit, 1050);
  assert.ok(lastJournals.rows.every((j) => j.lines.length === 1));

  const secondPage = await generalLedger(db, { accountId: account.id, ...range, page: 2, pageSize: 50 });
  assert.equal(secondPage.rows.length, 50);
  assert.deepEqual(secondPage.totals, { debit: 1050, credit: 0 });
  assert.deepEqual(secondPage.carried, { debit: 500, credit: 0 }, 'running balance must carry earlier pages');

  const found = await generalLedger(db, { accountId: account.id, ...range, search: 'entry 105' });
  assert.equal(found.pagination.total, 1);
  assert.equal(found.rows[0].memo, 'Entry 105');
});

test('customer ledger totals and search cover every page', async () => {
  await ensureSplitPaymentSchema(db);
  for (let i = 1; i <= 60; i += 1) {
    await db.run(
      `INSERT INTO customers (name, phone, current_credit) VALUES (?, ?, 100)`,
      [`Due Customer ${i}`, `98000${String(i).padStart(5, '0')}`]
    );
  }
  const special = await db.run(`INSERT INTO customers (name, phone, current_credit) VALUES ('Shristina Sapkota', '9858038225', 15989)`);
  await db.run(`INSERT INTO customer_ledger (customer_id, entry_type, debit, credit, note, idempotency_key) VALUES (?, 'credit_sale', 15989, 0, 'Birthday party', 'limit-charge')`, [special.lastInsertRowid]);
  await db.run(`INSERT INTO customer_ledger (customer_id, entry_type, debit, credit, idempotency_key) VALUES (?, 'credit_payment', 0, 989, 'limit-payment')`, [special.lastInsertRowid]);

  const firstPage = await customerReceivablesPage(db, { pageSize: 25 });
  assert.equal(firstPage.rows.length, 25);
  assert.equal(firstPage.pagination.total, 61);
  assert.equal(firstPage.summary.owed, 21989);

  const lastPage = await customerReceivablesPage(db, { page: 3, pageSize: 25 });
  assert.equal(lastPage.rows.length, 11);

  const byName = await customerReceivablesPage(db, { search: 'shristina', pageSize: 25 });
  assert.equal(byName.rows[0].name, 'Shristina Sapkota');
  assert.equal(byName.summary.owed, 15989);

  const history = await customerLedgerHistoryPage(db, { search: '9858038225', pageSize: 1 });
  assert.equal(history.rows.length, 1);
  assert.equal(history.pagination.total, 2);
  assert.deepEqual(history.summary, { charged: 15989, paid: 989 });
  assert.equal((await customerLedgerHistoryPage(db, { search: 'birthday' })).pagination.total, 1);
});

test('supplier ledger totals and search cover every page', async () => {
  await ensureAccountingSchema(db);
  await ensureLedgerSchema(db);
  const ap = await db.get(`SELECT id FROM accounts WHERE code = '2010'`);
  for (let i = 1; i <= 30; i += 1) {
    const supplier = await db.run(`INSERT INTO suppliers (name, normalized_name, phone) VALUES (?, ?, ?)`, [`Vendor ${i}`, `vendor ${i}`, `97000${String(i).padStart(5, '0')}`]);
    const entry = await db.run(
      `INSERT INTO journal_entries (entry_date, memo, source_type, source_id) VALUES ('2020-02-01', ?, 'purchase', ?)`,
      [`Invoice ${i}`, 9000 + i]
    );
    await db.run(
      `INSERT INTO journal_lines (journal_id, account_id, supplier_id, debit, credit) VALUES (?, ?, ?, 0, 200)`,
      [entry.lastInsertRowid, ap.id, supplier.lastInsertRowid]
    );
  }
  const page = await supplierPayablesPage(db, { page: 2, pageSize: 25 });
  assert.equal(page.pagination.total, 30);
  assert.equal(page.rows.length, 5);
  assert.equal(page.summary.owed, 6000);

  const found = await supplierPayablesPage(db, { search: 'vendor 17' });
  assert.equal(found.pagination.total, 1);
  assert.equal(found.rows[0].name, 'Vendor 17');

  const history = await supplierLedgerHistoryPage(db, { search: 'invoice 2', pageSize: 3 });
  assert.equal(history.rows.length, 3);
  assert.equal(history.pagination.total, 11);
  assert.equal(history.summary.charged, 2200);
});

test('supplier list totals cover every page', async () => {
  const { rows, summary, pagination } = await listSuppliers(db, { pageSize: 10, search: 'vendor' });
  assert.equal(rows.length, 10);
  assert.equal(pagination.total, 30);
  assert.equal(summary.suppliers, 30);
});
