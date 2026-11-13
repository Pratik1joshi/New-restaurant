/**
 * Local SQLite demo data for staff, payroll, food credit and customers.
 * Everything goes through the real payroll / billing functions, so balances,
 * journals and customer ledgers are consistent.
 *
 * Needs an open business day for today. Run once; a second run is a no-op.
 *   npm run db:seed-sqlite-staff
 */
import fs from 'node:fs';
import path from 'node:path';

if (process.env.DATABASE_URL || process.env.NODE_ENV === 'production') throw new Error('Demo seeding is allowed only in local SQLite development.');
const { PosDatabase } = await import('../lib/db/index.js');
const { ensurePayrollSchema, recordAdvance, recordPayment, advanceOutstanding } = await import('../lib/payroll.js');
const { monthlySalaryDetails, recordSalaryAdjustment } = await import('../lib/payroll-months.js');
const { syncStaffCustomer } = await import('../lib/staff-food-credit.js');
const { recordInitialSplitSettlement, validateAllocations, ensureSplitPaymentSchema, collectCreditBalance } = await import('../lib/split-payments.js');
const { ensureAccountingSchema } = await import('../lib/accounting.js');
const { currentBusinessDay, businessDayIdForCalendarDate } = await import('../lib/business-days.js');
const { ensureCustomersTable } = await import('../lib/customers.js');
const { nepalDateString } = await import('../lib/report-dates.js');

const argument = process.argv.find((v) => v.startsWith('--db='));
const target = path.resolve(argument ? argument.slice(5) : 'pos_restaurant.db');
if (!fs.existsSync(target)) throw new Error(`No SQLite database at ${target}.`);
const db = new PosDatabase(target);
const today = nepalDateString();
const thisMonth = today.slice(0, 7);
const shiftMonth = (month, by) => { const d = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7) - 1 + by, 1)); return d.toISOString().slice(0, 7); };
const lastMonth = shiftMonth(thisMonth, -1);
const twoAgo = shiftMonth(thisMonth, -2);
const day = (month, d) => `${month}-${String(d).padStart(2, '0')}`;
const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
let seq = 0;
const key = () => crypto.randomUUID();

await ensureAccountingSchema(db);
await ensurePayrollSchema(db);
await ensureSplitPaymentSchema(db);
await ensureCustomersTable(db);
const admin = await db.get("SELECT id, role, full_name FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
if (!(await currentBusinessDay(db))) throw new Error('Open today’s business day first (Admin → Business Day).');
if (await db.get("SELECT id FROM users WHERE username = 'demo.hari'")) {
  console.log('Staff demo already seeded. Restore a backup from .build-tmp to seed again.');
  process.exit(0);
}

// ── Staff ─────────────────────────────────────────────────────────────────
// Existing logins become real staff; new payroll-only staff have no login.
const STAFF = [
  { username: 'john', position: 'Head Waiter', phone: '9841000001', salary: 22000, hire: '2025-03-01' },
  { username: 'ram', position: 'Waiter', phone: '9841000002', salary: 18000, hire: '2025-07-15' },
  { username: 'sita', position: 'Cashier', phone: '9841000003', salary: 25000, hire: '2024-11-01' },
  { username: 'chef', position: 'Head Chef', phone: '9841000004', salary: 35000, raise: 38000, hire: '2024-06-01' },
  { username: 'demo.hari', full_name: 'Hari Bahadur', role: 'kitchen', position: 'Dishwasher', phone: '9841000005', salary: 14000, hire: '2026-01-10' },
  { username: 'demo.maya', full_name: 'Maya Tamang', role: 'kitchen', position: 'Kitchen Helper', phone: '9841000006', salary: 13000, hire: '2026-02-01' },
  { username: 'demo.bikash', full_name: 'Bikash Rai', role: 'waiter', position: 'Cleaner', phone: '9841000007', salary: 12000, hire: '2026-04-01' },
  // Same phone as an existing customer: shows an existing customer being linked.
  { username: 'demo.sunita', full_name: 'Sunita Lama', role: 'kitchen', position: 'Cook', phone: '9815678901', salary: 16000, hire: '2025-09-01' },
  { username: 'demo.raju', full_name: 'Raju Shrestha', role: 'waiter', position: 'Delivery Rider', phone: '9841000009', salary: 15000, hire: '2026-05-01' },
  { username: 'demo.gopal', full_name: 'Gopal Karki', role: 'kitchen', position: 'Helper (left)', phone: '9841000010', salary: 14000, hire: '2025-12-01', left: true },
  { username: 'demo.nophone', full_name: 'Kamala BK', role: 'kitchen', position: 'Helper', phone: null, salary: 12000, hire: '2026-08-01' },
];
const ids = {};
for (const s of STAFF) {
  const existing = await db.get('SELECT id FROM users WHERE username = ?', [s.username]);
  const current = s.raise || s.salary;
  const rate = round2(s.salary / 30);
  if (existing) {
    await db.run('UPDATE users SET phone = ?, position = ?, salary = ?, hire_date = ?, absence_daily_rate = ? WHERE id = ?', [s.phone, s.position, current, s.hire, rate, existing.id]);
    ids[s.username] = existing.id;
  } else {
    const r = await db.run(`INSERT INTO users (username, full_name, role, password_hash, phone, is_active, salary, hire_date, position, absence_daily_rate, can_login)
      VALUES (?, ?, ?, '!', ?, 1, ?, ?, ?, ?, 0)`, [s.username, s.full_name, s.role, s.phone, current, s.hire, s.position, rate]);
    ids[s.username] = Number(r.lastInsertRowid);
  }
  const id = ids[s.username];
  await db.run('DELETE FROM staff_salary_terms WHERE employee_id = ?', [id]);
  await db.run('INSERT INTO staff_salary_terms (employee_id, effective_month, salary, created_by) VALUES (?, ?, ?, ?)', [id, twoAgo, s.salary, admin.id]);
  if (s.raise) await db.run('INSERT INTO staff_salary_terms (employee_id, effective_month, salary, created_by) VALUES (?, ?, ?, ?)', [id, thisMonth, s.raise, admin.id]);
  await syncStaffCustomer(db, id);
}
await db.run("INSERT INTO system_settings (setting_key, setting_value) VALUES ('payroll_absence_deductions_enabled', 'true') ON CONFLICT (setting_key) DO UPDATE SET setting_value = 'true'");

// ── Helpers ───────────────────────────────────────────────────────────────
const menu = await db.all('SELECT id, name, base_price FROM menu_items WHERE is_available = 1 AND COALESCE(base_price, 0) > 0 ORDER BY id LIMIT 30');
if (!menu.length) throw new Error('No menu items found.');
let pick = 0;
const stamp = (date, hour) => new Date(`${date}T${String(hour).padStart(2, '0')}:15:00+05:45`).toISOString().slice(0, 19).replace('T', ' ');

/** A completed order + bill charged to a customer on credit (optionally part cash). */
async function creditBill(customerId, date, { items = 2, cash = 0, hour = 13 } = {}) {
  const dayId = date === today ? (await currentBusinessDay(db)).id : await businessDayIdForCalendarDate(db, date, { note: '[DEMO] staff demo' });
  const customer = await db.get('SELECT * FROM customers WHERE id = ?', [customerId]);
  const lines = Array.from({ length: items }, () => { const m = menu[pick++ % menu.length]; const q = 1 + (pick % 2); return { m, q, sub: round2(m.base_price * q) }; });
  const total = round2(lines.reduce((n, l) => n + l.sub, 0));
  const n = ++seq;
  const order = await db.run(`INSERT INTO orders (order_number, order_type, status, customer_id, customer_name, customer_phone, business_day_id, created_at, completed_at)
    VALUES (?, 'dine_in', 'completed', ?, ?, ?, ?, ?, ?)`, [`DEMO-S${n}`, customerId, customer.name, customer.phone, dayId, stamp(date, hour), stamp(date, hour + 1)]);
  for (const l of lines) {
    await db.run(`INSERT INTO order_items (order_id, item_id, menu_item_id, item_name, quantity, price, subtotal, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'served', ?)`, [order.lastInsertRowid, l.m.id, l.m.id, l.m.name, l.q, l.m.base_price, l.sub, stamp(date, hour)]);
  }
  const bill = await db.run(`INSERT INTO bills (bill_number, order_id, subtotal, grand_total, status, customer_id, outstanding_amount, payment_status, business_day_id, cashier_id, created_at)
    VALUES (?, ?, ?, ?, 'unpaid', ?, 0, 'unpaid', ?, ?, ?)`, [`DEMO-B${n}`, order.lastInsertRowid, total, total, customerId, dayId, admin.id, stamp(date, hour + 1)]);
  const cashPart = Math.min(cash, total);
  const raw = [{ method: 'credit', amount: round2(total - cashPart) }, ...(cashPart > 0 ? [{ method: 'cash', amount: cashPart, cash_tendered: cashPart }] : [])];
  await recordInitialSplitSettlement(db, { billId: bill.lastInsertRowid, billNumber: `DEMO-B${n}`, total, customer, actorId: admin.id, requestKey: key('bill'), businessDayId: dayId,
    allocations: validateAllocations(raw.filter((a) => a.amount > 0), total, { customer, actorRole: 'admin' }) });
  await db.run(`UPDATE customer_ledger SET created_at = ? WHERE bill_id = ?`, [stamp(date, hour + 1), bill.lastInsertRowid]);
  return { billId: Number(bill.lastInsertRowid), total };
}

/** Pay with the chosen method, falling back to Owner Pocket when a historic drawer is short. */
async function payout(fn, data) {
  try { return await fn(db, { ...data, request_key: key('pay') }, admin.id); }
  catch (error) {
    if (!['business_funding_required', 'business_funding_insufficient'].includes(error.code) && !/insufficient|short/i.test(error.message)) throw error;
    return fn(db, { ...data, method: 'owner_pocket', request_key: key('pay') }, admin.id);
  }
}

async function paySalary(username, month, paidOn, { short = 0, food = true, method = 'online' } = {}) {
  const id = ids[username];
  const { statement, food_credit: account } = await monthlySalaryDetails(db, id, month);
  if (!(statement.remaining > 0)) return;
  const settle = Math.min(await advanceOutstanding(db, id), statement.available_for_advance_settlement);
  const foodDeduction = food ? Math.min(Number(account?.outstanding || 0), statement.remaining) : 0;
  const gross = round2(statement.remaining + settle - short);
  await payout(recordPayment, { employee_id: id, salary_month: month, period_label: month, paid_on: paidOn, method,
    gross_amount: gross, advance_deduction: round2(settle), food_deduction: round2(foodDeduction), amount: round2(gross - settle - foodDeduction),
    note: '[DEMO] Monthly salary' });
}
const customerOf = async (username) => (await db.get('SELECT id FROM customers WHERE employee_id = ?', [ids[username]])).id;
const absence = (username, month, days, note) => recordSalaryAdjustment(db, { employee_id: ids[username], salary_month: month, type: 'absence', absent_days: days, note, request_key: key('abs') }, admin.id);

// ── Two months ago: advances, then full salary ───────────────────────────
await payout(recordAdvance, { employee_id: ids.ram, amount: 3000, method: 'cash', advanced_on: day(twoAgo, 12), note: '[DEMO] Festival advance' });
await payout(recordAdvance, { employee_id: ids['demo.hari'], amount: 2000, method: 'cash', advanced_on: day(twoAgo, 20), note: '[DEMO] Medical' });
await absence('demo.bikash', twoAgo, 2, '[DEMO] Sick leave unpaid');
for (const s of STAFF) await paySalary(s.username, twoAgo, day(lastMonth, 1), { method: s.salary > 20000 ? 'online' : 'cash' });

// ── Last month: food credit, advances, absences, salary with deductions ──
const foodStaff = ['john', 'ram', 'demo.hari', 'demo.maya', 'demo.bikash', 'demo.sunita', 'demo.raju', 'demo.gopal'];
for (const [i, username] of foodStaff.entries()) {
  const customerId = await customerOf(username);
  for (const d of [4 + i, 11 + i, 19 + (i % 5)]) await creditBill(customerId, day(lastMonth, d), { items: 1 + (d % 3), hour: 14 });
}
await payout(recordAdvance, { employee_id: ids.sita, amount: 5000, method: 'online', advanced_on: day(lastMonth, 8), note: '[DEMO] Rent advance' });
await payout(recordAdvance, { employee_id: ids['demo.raju'], amount: 4000, method: 'cash', advanced_on: day(lastMonth, 15), note: '[DEMO] Bike repair' });
await absence('demo.maya', lastMonth, 1, '[DEMO] Absent without notice');
await absence('demo.raju', lastMonth, 3, '[DEMO] Home visit');
const sunitaLeave = await absence('demo.sunita', lastMonth, 2, '[DEMO] Personal leave');
await recordSalaryAdjustment(db, { employee_id: ids['demo.sunita'], salary_month: lastMonth, type: 'absence_waiver', amount: round2(sunitaLeave.amount / 2), note: '[DEMO] Owner waived one day', request_key: key('w') }, admin.id);
for (const s of STAFF) {
  if (s.username === 'demo.gopal') continue; // left: salary handled below
  await paySalary(s.username, lastMonth, day(today.slice(0, 7), 1), {
    short: s.username === 'ram' ? 3000 : 0, // ram is owed Rs 3000, carried forward
    food: s.username !== 'demo.raju', // raju's food credit not deducted yet
    method: s.salary > 20000 ? 'online' : 'cash',
  });
}
// Gopal left: paid salary but his food credit was never deducted, so it is still open.
await paySalary('demo.gopal', lastMonth, day(lastMonth, 28), { food: false, method: 'cash' });
// Leaving staff stop accruing salary: salary 0 from this month.
await db.run('UPDATE users SET is_active = 0, salary = 0 WHERE id = ?', [ids['demo.gopal']]);
await db.run('INSERT INTO staff_salary_terms (employee_id, effective_month, salary, created_by) VALUES (?, ?, 0, ?)', [ids['demo.gopal'], thisMonth, admin.id]);

// ── This month (open): more food credit, an advance, absence; not paid yet
for (const [i, username] of ['john', 'ram', 'demo.hari', 'demo.maya', 'demo.sunita', 'demo.raju', 'sita', 'chef'].entries()) {
  const customerId = await customerOf(username);
  const days = Array.from({ length: Math.min(3, Number(today.slice(8))) }, (_, k) => Math.max(1, Number(today.slice(8)) - k * 3 - (i % 2)));
  for (const d of days) await creditBill(customerId, day(thisMonth, Math.min(d, Number(today.slice(8)))), { items: 1 + ((d + i) % 3), hour: 15 });
}
await payout(recordAdvance, { employee_id: ids.john, amount: 2500, method: 'cash', advanced_on: today, note: '[DEMO] Advance' });
await absence('demo.hari', thisMonth, 1, '[DEMO] Absent');
// Maya paid part of her food credit in cash herself.
const mayaBill = await db.get("SELECT id, outstanding_amount FROM bills WHERE customer_id = ? AND outstanding_amount > 0 ORDER BY id DESC LIMIT 1", [await customerOf('demo.maya')]);
if (mayaBill) await collectCreditBalance(db, { billId: mayaBill.id, allocations: [{ method: 'cash', amount: round2(mayaBill.outstanding_amount / 2), cash_tendered: round2(mayaBill.outstanding_amount / 2) }], actorId: admin.id, requestKey: key('collect') });

// ── Regular customers: VIPs, credit customers, blacklisted ───────────────
const CUSTOMERS = [
  ['Aarav Shrestha', '9851100001', { vip: true }], ['Binita Maharjan', '9851100002', { credit: 2 }], ['Chiranjibi Poudel', '9851100003', {}],
  ['Deepa Bhandari', '9851100004', { vip: true, credit: 1 }], ['Ekraj Thapa', '9851100005', { credit: 3 }], ['Fulmaya Gurung', '9851100006', {}],
  ['Gaurav Basnet', '9851100007', { blacklisted: true, credit: 1 }], ['Hima Shahi', '9851100008', {}], ['Ishan Karki', '9851100009', { vip: true }],
  ['Junu Rana', '9851100010', { credit: 2, paid: true }], ['Kiran Dahal', '9851100011', {}], ['Laxmi Neupane', '9851100012', { credit: 1 }],
  ['Manish Khadka', '9851100013', {}], ['Nisha Pandey', '9851100014', { vip: true, credit: 2, paid: true }], ['Om Prakash Yadav', '9851100015', {}],
  ['Puja Bista', '9851100016', { credit: 1 }], ['Rabin Magar', '9851100017', {}], ['Sabina Oli', '9851100018', { credit: 2 }],
  ['Tenzing Sherpa', '9851100019', { vip: true }], ['Usha Giri', '9851100020', {}],
];
for (const [i, [name, phone, o]] of CUSTOMERS.entries()) {
  const r = await db.run(`INSERT INTO customers (name, phone, email, address, credit_limit, current_credit, is_vip, is_blacklisted, total_visits, total_spent, notes)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`, [name, phone, i % 3 ? null : `${name.split(' ')[0].toLowerCase()}@example.com`, ['Thamel', 'Baneshwor', 'Lalitpur', 'Bhaktapur', 'Kirtipur'][i % 5],
    o.credit ? 10000 : 0, o.vip ? 1 : 0, 0, 3 + (i * 7) % 40, 2500 + i * 1830, '[DEMO] customer']);
  for (let c = 0; c < (o.credit || 0); c += 1) {
    const d = Math.min(5 + (i % 20), 28, c === 0 ? 28 : Number(today.slice(8)));
    const { billId } = await creditBill(Number(r.lastInsertRowid), day(c === 0 ? lastMonth : thisMonth, d), { items: 3, cash: c === 0 ? 300 : 0, hour: 19 });
    const due = Number((await db.get('SELECT outstanding_amount FROM bills WHERE id = ?', [billId])).outstanding_amount);
    if (o.paid && c === 0 && due > 0) await collectCreditBalance(db, { billId, allocations: [{ method: 'online', amount: due }], actorId: admin.id, requestKey: key('collect') });
  }
  // Blacklisted after running up credit: their old debt stays open.
  if (o.blacklisted) await db.run('UPDATE customers SET is_blacklisted = 1 WHERE id = ?', [r.lastInsertRowid]);
}

// ── Summary ───────────────────────────────────────────────────────────────
const rows = await db.all(`SELECT u.full_name, u.position, COALESCE(u.can_login, 1) AS login, u.is_active, COALESCE(c.current_credit, 0) AS food_due
  FROM users u LEFT JOIN customers c ON c.employee_id = u.id ORDER BY u.id`);
console.table(rows);
console.log(JSON.stringify({
  months: [twoAgo, lastMonth, thisMonth],
  salary_payments: (await db.get('SELECT COUNT(*) n FROM salary_payments')).n,
  advances: (await db.get('SELECT COUNT(*) n FROM salary_advances')).n,
  adjustments: (await db.get('SELECT COUNT(*) n FROM staff_salary_adjustments')).n,
  staff_food_bills: (await db.get("SELECT COUNT(*) n FROM bills b JOIN customers c ON c.id = b.customer_id WHERE c.employee_id IS NOT NULL")).n,
  customers: (await db.get('SELECT COUNT(*) n FROM customers')).n,
  open_credit: (await db.get('SELECT ROUND(SUM(current_credit), 2) n FROM customers')).n,
}, null, 2));
