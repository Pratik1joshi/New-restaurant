import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DB_NAME = `staff-food-credit-test-${process.pid}-${Date.now()}.db`;
const Database = (await import('../../lib/db/index.js')).default;
const db = Database.getInstance();
const { POST: createStaff } = await import('../../app/api/admin/employees/route.js');
const { PUT: updateStaff } = await import('../../app/api/admin/employees/[id]/route.js');
const { POST: payrollPost, GET: payrollGet, DELETE: payrollDelete } = await import('../../app/api/admin/payroll/route.js');
const { POST: arPost } = await import('../../app/api/admin/accounts-receivable/route.js');
const { openBusinessDay } = await import('../../lib/business-days.js');
const { nepalDateString } = await import('../../lib/report-dates.js');
const { recordInitialSplitSettlement, validateAllocations, ensureSplitPaymentSchema } = await import('../../lib/split-payments.js');
const { AuthService } = await import('../../lib/auth/auth.js');

const token = 'food-credit-admin';
const month = nepalDateString().slice(0, 7);
let staffId;
let customerId;
let dayId;
const req = (url, method, body, session = token) => new Request(`http://localhost${url}`, {
  method, headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
});
const json = async (response, status) => { const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data; };
const credit = async () => Number((await db.get('SELECT current_credit FROM customers WHERE id = ?', [customerId])).current_credit);

async function foodBill(number, total) {
  const order = await db.run("INSERT INTO orders (order_number, status, customer_id, customer_name, business_day_id) VALUES (?, 'completed', ?, 'Hari', ?)", [`O-${number}`, customerId, dayId]);
  const bill = await db.run(`INSERT INTO bills (bill_number, order_id, subtotal, grand_total, status, customer_id, outstanding_amount, payment_status, business_day_id, created_at)
    VALUES (?, ?, ?, ?, 'unpaid', ?, 0, 'unpaid', ?, CURRENT_TIMESTAMP)`, [number, order.lastInsertRowid, total, total, customerId, dayId]);
  const customer = await db.get('SELECT * FROM customers WHERE id = ?', [customerId]);
  await recordInitialSplitSettlement(db, { billId: bill.lastInsertRowid, billNumber: number, total, customer, actorId: 1, requestKey: `init-${number}`, businessDayId: dayId,
    allocations: validateAllocations([{ method: 'credit', amount: total }], total, { customer, actorRole: 'admin' }) });
}

test.after(async () => {
  await Database.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(path.join('databases', process.env.DB_NAME) + suffix); } catch { /* closed */ }
  }
});

test('payroll-only staff: no PIN, cannot sign in, linked to a POS customer by phone', async () => {
  const admin = await db.get("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  await db.run("INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, datetime('now', '+1 day'))", [admin.id, token]);
  dayId = (await openBusinessDay(db, { business_date: nepalDateString(), opening_cash: 50000 }, { ...admin, role: 'admin' })).id;
  await ensureSplitPaymentSchema(db);
  const data = await json(await createStaff(req('/api/admin/employees', 'POST', {
    full_name: 'Hari Dishwasher', role: 'kitchen', position: 'Dishwasher', can_login: false, phone: '9811111111', salary: 15000,
  })), 201);
  staffId = data.employee.id;
  assert.equal(Number(data.employee.can_login), 0);
  const customer = await db.get('SELECT * FROM customers WHERE employee_id = ?', [staffId]);
  assert.equal(customer.phone, '9811111111');
  customerId = customer.id;
  const login = await new AuthService().authenticate(data.employee.username, '!');
  assert.equal(login.success, false);
  // Sign-in cannot be turned on without a PIN; admins must keep sign-in.
  await json(await updateStaff(req(`/api/admin/employees/${staffId}`, 'PUT', { can_login: true }), { params: Promise.resolve({ id: staffId }) }), 400);
  await json(await createStaff(req('/api/admin/employees', 'POST', { full_name: 'No Login Admin', role: 'admin', can_login: false })), 400);
});

test('food credit is deducted from salary, books AR, and reverses on delete', async () => {
  await foodBill('FOOD-1', 1200);
  await foodBill('FOOD-2', 800);
  assert.equal(await credit(), 2000);

  const details = await json(await payrollGet(req(`/api/admin/payroll?employee_id=${staffId}&month=${month}`, 'GET')), 200);
  assert.equal(details.food_credit.outstanding, 2000);
  assert.ok(Array.isArray(details.food_bills));

  // Deduction above the food credit due is refused.
  await json(await payrollPost(req('/api/admin/payroll', 'POST', { employee_id: staffId, salary_month: month, gross_amount: 15000, food_deduction: 2500, amount: 12500, method: 'cash' })), 400);
  const paid = await json(await payrollPost(req('/api/admin/payroll', 'POST', { employee_id: staffId, salary_month: month, gross_amount: 15000, food_deduction: 1500, amount: 13500, method: 'cash' })), 201);
  assert.equal(await credit(), 500);
  const bills = await db.all("SELECT bill_number, outstanding_amount, payment_status FROM bills WHERE bill_number LIKE 'FOOD-%' ORDER BY bill_number");
  assert.deepEqual(bills.map((b) => [b.bill_number, Number(b.outstanding_amount), b.payment_status]), [['FOOD-1', 0, 'paid'], ['FOOD-2', 500, 'partially_paid']]);

  const after = await json(await payrollGet(req(`/api/admin/payroll?employee_id=${staffId}&month=${month}`, 'GET')), 200);
  assert.equal(after.statement.food_deducted, 1500);
  assert.equal(after.statement.balance, 0);
  const journal = await db.get("SELECT id FROM journal_entries WHERE source_type = 'payroll' AND source_id = ?", [paid.payment.id]);
  const ar = await db.get("SELECT SUM(l.credit) AS cr FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.journal_id = ? AND a.code = '1300'", [journal.id]);
  assert.equal(Number(ar.cr), 1500);

  const sheet = await json(await payrollGet(req(`/api/admin/payroll?view=sheet&month=${month}`, 'GET')), 200);
  const row = sheet.employees.find((e) => Number(e.id) === Number(staffId));
  assert.equal(row.food_taken, 2000);
  assert.equal(Number(row.food_outstanding), 500);

  await json(await payrollDelete(req(`/api/admin/payroll?id=${paid.payment.id}`, 'DELETE')), 200);
  assert.equal(await credit(), 2000);
  assert.equal(Number((await db.get("SELECT outstanding_amount FROM bills WHERE bill_number = 'FOOD-1'")).outstanding_amount), 1200);
  assert.equal(await db.get("SELECT id FROM customer_ledger WHERE idempotency_key LIKE 'salary-food:%'"), undefined);
});

test('food credit cap blocks POS credit above remaining salary only when enabled', async () => {
  await db.run("UPDATE system_settings SET setting_value = 'true' WHERE setting_key = 'payroll_food_credit_cap_enabled'");
  await assert.rejects(() => foodBill('FOOD-3', 13500), (e) => e.code === 'staff_food_credit_cap');
  await db.run("UPDATE system_settings SET setting_value = 'false' WHERE setting_key = 'payroll_food_credit_cap_enabled'");
  await foodBill('FOOD-4', 100);
  assert.equal(await credit(), 2100);
});

test('only an admin can waive staff food credit; settle works by cash', async () => {
  const cashier = await db.get("SELECT id FROM users WHERE role = 'cashier' LIMIT 1");
  await db.run("INSERT INTO sessions (user_id, token, expires_at) VALUES (?, 'food-cashier', datetime('now', '+1 day'))", [cashier.id]);
  const denied = await arPost(req('/api/admin/accounts-receivable', 'POST', { action: 'writeoff', customer_id: customerId, amount: 100, reason: 'test' }, 'food-cashier'));
  assert.equal(denied.status, 403);
  await json(await arPost(req('/api/admin/accounts-receivable', 'POST', { customer_id: customerId, amount: 100, method: 'cash', external_ref: 'settle-1' })), 201);
  await json(await arPost(req('/api/admin/accounts-receivable', 'POST', { action: 'writeoff', customer_id: customerId, amount: 2000, reason: 'Staff left, owner forgave', external_ref: 'waive-1' })), 201);
  assert.equal(await credit(), 0);
});
