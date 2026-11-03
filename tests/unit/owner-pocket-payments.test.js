import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PosDatabase } from '../../lib/db/index.js';
import { accountBalance, postExpenseJournal } from '../../lib/accounting.js';
import { openBusinessDay } from '../../lib/business-days.js';
import { businessFundingProfile } from '../../lib/business-funding.js';
import { ensurePayrollSchema, recordAdvance, recordPayment, deleteAdvance, deletePayment, advanceOutstanding, listPayments } from '../../lib/payroll.js';
import { paySupplier, supplierStatement, supplierLedgerHistory, creditPurchaseSettlements } from '../../lib/accounting-suppliers.js';
import { reverseCorrectionByJournal } from '../../lib/bill-corrections.js';
import { ensureReportSchema } from '../../lib/reports.js';
import { buildSummaryReport } from '../../lib/summary-report.js';
import { nepalDateString } from '../../lib/report-dates.js';

test('Owner Pocket settles supplier credit, advances and salaries without spending business money', async () => {
  const file = path.join(os.tmpdir(), `owner-pocket-${process.pid}-${Date.now()}.db`);
  const db = new PosDatabase(file);
  try {
    const today = nepalDateString();
    const actor = { id: 1, role: 'admin', full_name: 'Admin' };
    await ensurePayrollSchema(db);
    await openBusinessDay(db, { business_date: today, opening_cash: 0 }, actor);
    await ensureReportSchema(db);
    const employeeId = (await db.get("SELECT id FROM users WHERE role='waiter' LIMIT 1")).id;
    const balances = () => Promise.all(['1010', '1020', '1050'].map((code) => accountBalance(db, code)));
    const before = await balances();
    const equity = await accountBalance(db, '3010');
    const supplierId = (await db.run("INSERT INTO suppliers (name, normalized_name) VALUES ('Personal payment supplier', 'personal payment supplier')")).lastInsertRowid;
    const purchaseId = (await db.run("INSERT INTO purchases (supplier_id, supplier, total, status, invoice_date) VALUES (?, 'Personal payment supplier', 500, 'received', ?)", [supplierId, today])).lastInsertRowid;
    const expenseId = (await db.run("INSERT INTO expenses (description, amount, payment_method, expense_date, source_type, source_id) VALUES ('Credit stock',500,'credit',?,'purchase',?)", [today, purchaseId])).lastInsertRowid;
    await postExpenseJournal(db, { id: expenseId, amount: 500, payment_method: 'credit', expense_date: today, source_type: 'purchase', source_id: purchaseId, supplier_id: supplierId });

    await assert.rejects(() => paySupplier(db, { supplier_id: supplierId, amount: 501, method: 'owner_pocket' }), /only owed/);
    const journalId = await paySupplier(db, { supplier_id: supplierId, amount: 300, method: 'owner_pocket', created_by: actor.id });
    assert.equal(await accountBalance(db, '2010', { supplierId }), -200);
    assert.equal((await supplierStatement(db, supplierId)).find((r) => r.journal_id === journalId).payment_method, 'owner_pocket');
    assert.equal((await supplierLedgerHistory(db)).find((r) => r.journal_id === journalId).payment_method, 'owner_pocket');
    assert.deepEqual((await creditPurchaseSettlements(db)).get(Number(purchaseId)), { due: 200, paid: { funding: 300 } });

    const advanceData = { employee_id: employeeId, amount: 200, method: 'owner_pocket', request_key: 'personal-advance' };
    const advance = await recordAdvance(db, advanceData, actor.id);
    assert.equal((await recordAdvance(db, advanceData, actor.id)).id, advance.id);
    const paymentData = { employee_id: employeeId, amount: 400, gross_amount: 600, advance_deduction: 200, method: 'owner_pocket', request_key: 'personal-salary' };
    const payment = await recordPayment(db, paymentData, actor.id);
    assert.equal((await recordPayment(db, paymentData, actor.id)).id, payment.id);
    assert.equal(await advanceOutstanding(db, employeeId), 0);
    assert.equal((await listPayments(db, employeeId))[0].method, 'owner_pocket');
    assert.deepEqual(await balances(), before);
    assert.equal(await accountBalance(db, '3010'), equity - 900);
    assert.equal((await businessFundingProfile(db)).totalUsed, 0);
    const summary = await buildSummaryReport(db, { start: today, end: today });
    assert.equal(summary.salary.cash, 0);
    assert.equal(summary.salary.bank, 0);
    assert.equal(summary.salary.funding, 400);
    assert.equal(summary.salary.advance_deductions, 200);
    assert.equal(summary.salary.total, 600);

    await deletePayment(db, payment.id);
    assert.equal(await advanceOutstanding(db, employeeId), 200);
    await deleteAdvance(db, advance.id);
    await reverseCorrectionByJournal(db, { journal_id: journalId, reason: 'Personal payment reversed', created_by: actor.id });
    assert.equal(await accountBalance(db, '2010', { supplierId }), -500);
    assert.equal(await accountBalance(db, '3010'), equity);
    assert.deepEqual(await balances(), before);
    assert.deepEqual((await creditPurchaseSettlements(db)).get(Number(purchaseId)), { due: 500, paid: {} });
    assert.equal((await buildSummaryReport(db, { start: today, end: today })).salary.total, 0);
  } finally {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) try { fs.unlinkSync(file + suffix); } catch { /* closed */ }
  }
});
