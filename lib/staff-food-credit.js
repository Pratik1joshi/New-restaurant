/**
 * Staff food credit.
 *
 * A staff member is linked to one customer record (customers.employee_id). Food
 * they take on credit at POS is an ordinary credit sale on that customer, so
 * bills, stock, revenue, statements and Accounts Receivable all work unchanged.
 * A salary payment can then settle part of that receivable (food_deduction):
 * Dr Salaries (gross) / Cr Accounts Receivable (food) / Cr cash (net).
 */
import { ensureColumn } from '@/lib/db/schema-helpers.js';
import { findCustomerByPhone, normalizePhone } from '@/lib/customers.js';

const fail = (message, status = 400, extra = {}) => { throw Object.assign(new Error(message), { status, ...extra }); };
const cents = (n) => Math.round(Number(n || 0) * 100);
const money = (c) => Math.round(c) / 100;
export const FOOD_CAP_SETTING = 'payroll_food_credit_cap_enabled';
const keyPrefix = (paymentId) => `salary-food:${paymentId}:`;

export async function ensureStaffFoodCreditSchema(db) {
  if (db.driver === 'postgres') {
    const ready = await db.get(`SELECT 1 AS ok FROM information_schema.columns
      WHERE table_name = 'salary_payments' AND column_name = 'food_deduction' AND table_schema = ANY (current_schemas(false))`);
    if (!ready) throw Object.assign(new Error('Staff food credit needs an update. Run npm run db:migrate (through migration 078).'), { status: 503, expose: true });
    return;
  }
  await ensureColumn(db, 'users', 'can_login', 'INTEGER DEFAULT 1');
  await ensureColumn(db, 'customers', 'employee_id', 'INTEGER');
  await ensureColumn(db, 'salary_payments', 'food_deduction', 'DOUBLE PRECISION DEFAULT 0');
  await db.run('CREATE UNIQUE INDEX IF NOT EXISTS ux_customers_employee_id ON customers(employee_id) WHERE employee_id IS NOT NULL').catch(() => {});
  await db.run(`INSERT INTO system_settings (setting_key, setting_value) VALUES (?, 'false') ON CONFLICT (setting_key) DO NOTHING`, [FOOD_CAP_SETTING]).catch(() => {});
}

/**
 * Link a staff member to a customer: keep an existing link, else adopt the
 * customer with the same phone, else create one. Needs a 10-digit phone because
 * POS finds customers by phone.
 */
export async function syncStaffCustomer(db, employeeId) {
  const linked = await db.get('SELECT * FROM customers WHERE employee_id = ?', [employeeId]);
  if (linked) return linked;
  const user = await db.get('SELECT id, full_name, username, phone FROM users WHERE id = ?', [employeeId]);
  const digits = normalizePhone(user?.phone || '');
  if (!user || digits.length !== 10) return null;
  const existing = await findCustomerByPhone(db, digits);
  if (existing) {
    // Never take over a customer that already belongs to another staff member.
    if (existing.employee_id && Number(existing.employee_id) !== Number(employeeId)) return null;
    await db.run('UPDATE customers SET employee_id = ? WHERE id = ?', [employeeId, existing.id]);
    return db.get('SELECT * FROM customers WHERE id = ?', [existing.id]);
  }
  const result = await db.run(
    `INSERT INTO customers (name, phone, total_visits, total_spent, credit_limit, current_credit, employee_id)
     VALUES (?, ?, 0, 0, 0, 0, ?)`,
    [user.full_name || user.username, digits, employeeId]
  );
  return db.get('SELECT * FROM customers WHERE id = ?', [result.lastInsertRowid]);
}

/** Link every staff member who has a phone but no customer yet. Idempotent. */
export async function ensureStaffCustomerLinks(db) {
  const unlinked = await db.all(`SELECT u.id FROM users u
    WHERE u.phone IS NOT NULL AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.employee_id = u.id)`);
  for (const row of unlinked) await syncStaffCustomer(db, row.id).catch(() => null);
}

export async function foodCreditAccount(db, employeeId) {
  const c = await db.get('SELECT id, name, phone, current_credit FROM customers WHERE employee_id = ?', [employeeId]);
  return c ? { customer_id: c.id, customer_name: c.name, phone: c.phone, outstanding: money(cents(c.current_credit)) } : null;
}

/** Credit-sale food taken per staff customer in one AD month (business day date). */
export async function foodTakenInMonth(db, month) {
  const rows = await db.all(`SELECT c.employee_id, COALESCE(SUM(cl.debit), 0) AS taken
    FROM customer_ledger cl
    JOIN customers c ON c.id = cl.customer_id AND c.employee_id IS NOT NULL
    LEFT JOIN business_days bd ON bd.id = cl.business_day_id
    WHERE cl.entry_type = 'credit_sale'
      AND substr(COALESCE(CAST(bd.business_date AS TEXT), CAST(cl.created_at AS TEXT)), 1, 7) = ?
    GROUP BY c.employee_id`, [month]);
  return new Map(rows.map((r) => [Number(r.employee_id), money(cents(r.taken))]));
}

export async function foodCreditCapEnabled(db) {
  const row = await db.get('SELECT setting_value FROM system_settings WHERE setting_key = ?', [FOOD_CAP_SETTING]).catch(() => null);
  return row?.setting_value === 'true';
}

/**
 * When the admin cap is on, a staff member's food credit may not exceed what is
 * left of this month's salary. No-op for ordinary customers or with the cap off.
 */
export async function assertStaffFoodCreditCap(db, customerId, creditAmount) {
  if (!customerId || !(Number(creditAmount) > 0)) return;
  const customer = await db.get('SELECT * FROM customers WHERE id = ?', [customerId]);
  if (!customer?.employee_id || !(await foodCreditCapEnabled(db))) return;
  const { monthlySalaryDetails } = await import('@/lib/payroll-months.js');
  const { statement } = await monthlySalaryDetails(db, customer.employee_id);
  const available = Math.max(0, cents(statement.remaining) - cents(customer.current_credit));
  if (cents(creditAmount) > available) {
    fail(`Food credit limit reached for ${customer.name}. Only Rs ${money(available).toFixed(2)} of this month's salary is left for food credit. Take payment now, or an admin can turn off the staff food credit limit in Settings.`,
      409, { code: 'staff_food_credit_cap' });
  }
}

/** Clear food credit bills oldest first against a salary payment. Runs inside the payment transaction. */
export async function settleFoodCreditFromSalary(tx, { employeeId, amount, paymentId, actorId, businessDayId, label }) {
  let left = cents(amount);
  if (left <= 0) return;
  const lock = tx.driver === 'postgres' ? ' FOR UPDATE' : '';
  const customer = await tx.get(`SELECT * FROM customers WHERE employee_id = ?${lock}`, [employeeId]);
  if (!customer) fail('This staff member has no linked customer account for food credit. Add a 10-digit phone number on the staff record.');
  if (left > cents(customer.current_credit)) fail(`Food credit deduction cannot exceed the outstanding food credit (Rs ${money(cents(customer.current_credit)).toFixed(2)}).`);
  const bills = await tx.all(`SELECT id, bill_number, outstanding_amount FROM bills
    WHERE customer_id = ? AND COALESCE(outstanding_amount, 0) > 0.009
      AND LOWER(COALESCE(status, '')) NOT IN ('void', 'voided', 'cancelled', 'canceled')
    ORDER BY created_at ASC, id ASC${lock}`, [customer.id]);
  for (const bill of bills) {
    if (left <= 0) break;
    const due = cents(bill.outstanding_amount);
    const take = Math.min(left, due);
    const remaining = money(due - take);
    await tx.run(`INSERT INTO customer_ledger (customer_id, bill_id, entry_type, debit, credit, note, created_by, idempotency_key, business_day_id)
      VALUES (?, ?, 'adjustment', 0, ?, ?, ?, ?, ?)`,
    [customer.id, bill.id, money(take), `Salary deduction — ${label}`, actorId, `${keyPrefix(paymentId)}${bill.id}`, businessDayId]);
    await tx.run(`UPDATE bills SET outstanding_amount = ?, payment_status = ?, status = ?, paid_at = ${remaining > 0 ? 'NULL' : 'CURRENT_TIMESTAMP'} WHERE id = ?`,
      [remaining, remaining > 0 ? 'partially_paid' : 'paid', remaining > 0 ? 'partially_paid' : 'paid', bill.id]);
    left -= take;
  }
  if (left > 0) fail('Open food credit bills do not cover this deduction. Check the staff member’s credit bills in Customers.', 409);
  await tx.run(`UPDATE customers SET current_credit = CASE WHEN COALESCE(current_credit, 0) - ? < 0 THEN 0 ELSE COALESCE(current_credit, 0) - ? END WHERE id = ?`,
    [Number(amount), Number(amount), customer.id]);
  return customer.id;
}

/** Undo settleFoodCreditFromSalary when its salary payment is deleted. */
export async function reverseFoodSettlement(tx, paymentId) {
  const rows = await tx.all('SELECT * FROM customer_ledger WHERE idempotency_key LIKE ?', [`${keyPrefix(paymentId)}%`]);
  let total = 0;
  for (const row of rows) {
    await tx.run(`UPDATE bills SET outstanding_amount = COALESCE(outstanding_amount, 0) + ?, payment_status = 'partially_paid', status = 'partially_paid', paid_at = NULL WHERE id = ?`,
      [Number(row.credit), row.bill_id]);
    total += cents(row.credit);
  }
  if (rows.length) {
    await tx.run('UPDATE customers SET current_credit = COALESCE(current_credit, 0) + ? WHERE id = ?', [money(total), rows[0].customer_id]);
    await tx.run('DELETE FROM customer_ledger WHERE idempotency_key LIKE ?', [`${keyPrefix(paymentId)}%`]);
  }
}
