import test from 'node:test';
import assert from 'node:assert/strict';
import Database from '@/lib/db/index.js';
import { ensureReportSchema, buildReport } from '@/lib/reports.js';
import { createPurchase, listPurchases } from '@/lib/purchases.js';
import { transactionReport, composeAnalytics } from '@/lib/analytics.js';
import { openBusinessDay } from '@/lib/business-days.js';
import { nepalDateString } from '@/lib/report-dates.js';
import { analyticsSections, reportCsv, reportWorkbook } from '@/lib/report-export.js';

if (!process.env.DATABASE_URL || !/^\/km_test_\d+_\d+$/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('Run with scripts/run-integration.mjs against an isolated local PostgreSQL server.');
const db = Database.getInstance();
test.after(async () => { await Database.close(); });

test('PostgreSQL exports retain real purchase names and nonzero analytics amounts', async () => {
  await ensureReportSchema(db);
  const day = await openBusinessDay(db, { opening_cash: 10000 }, { id: 1, role: 'admin' });
  const today = nepalDateString();
  const range = { start: today, end: today, period: 'custom' };
  const onion = (await db.run("INSERT INTO inventory_items(item_name,name,unit,purchase_unit,consumption_unit,conversion_factor,quantity,cost_per_unit) VALUES ('Export onion','Export onion','g','kg','g',1000,0,0)")).lastInsertRowid;
  const oil = (await db.run("INSERT INTO inventory_items(item_name,name,unit,purchase_unit,consumption_unit,conversion_factor,quantity,cost_per_unit) VALUES ('Export oil','Export oil','ml','l','ml',1000,0,0)")).lastInsertRowid;
  const purchase = await createPurchase(db, { supplier: 'Export supplier', invoice_number: 'EXPORT-PURCHASE', invoice_date: today, payment_method: 'cash', performed_by: 1, received_by: 1, items: [
    { inventory_item_id: onion, quantity: 2, unit_cost: 100.25 },
    { inventory_item_id: oil, quantity: 1, unit_cost: 200.25 },
  ] });
  const list = await listPurchases(db, { exportAll: true });
  assert.equal(list.rows.find((r) => Number(r.id) === Number(purchase.id)).item_names, 'Export onion — 2 kg @ Rs 100.25; Export oil — 1 l @ Rs 200.25');
  const report = await buildReport(db, 'purchases', range, { exportAll: true });
  assert.match(report.tables[0].rows[0].item_names, /Export onion/);
  assert.match(report.tables[0].rows[0].item_names, /Export oil/);
  assert.equal(report.tables[0].rows[0].total, 400.75);

  const order = (await db.run("INSERT INTO orders(order_number,status,order_type,business_day_id) VALUES ('EXPORT-ORDER','completed','takeaway',?)", [day.id])).lastInsertRowid;
  await db.run("INSERT INTO order_items(order_id,item_name,quantity,price,subtotal,status) VALUES (?,'Export meal',1,1234.56,1234.56,'served')", [order]);
  const bill = (await db.run("INSERT INTO bills(bill_number,order_id,subtotal,grand_total,status,business_day_id) VALUES ('EXPORT-BILL',?,1234.56,1234.56,'paid',?)", [order, day.id])).lastInsertRowid;
  await db.run("INSERT INTO bill_payments(bill_id,amount,payment_method,business_day_id) VALUES (?,1234.56,'cash',?)", [bill, day.id]);
  const transactions = await transactionReport(db, range, { exportAll: true, businessDayId: day.id });
  assert.equal(transactions.rows.length, 1);
  assert.equal(transactions.rows[0].final_total, 1234.56);
  assert.equal(transactions.rows[0].cash_amount, 1234.56);
  const overview = await composeAnalytics(db, range, {}, { transactions: { exportAll: true }, businessDayId: day.id });
  assert.equal(overview.recentTransactions.length, 1);
  const sections = analyticsSections(overview, overview.recentTransactions);
  assert.match(reportCsv('Analytics', sections), /1234.56/);
  assert.match(reportWorkbook('Analytics', sections), /ss:Type="Number">1234.56/);
});
