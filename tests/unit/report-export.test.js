import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyticsSections, reportCsv, reportWorkbook } from '@/lib/report-export.js';
import { parseCsv } from '@/lib/csv.js';
import { purchaseItemSummaries } from '@/lib/purchase-item-report.js';
import { PosDatabase } from '@/lib/db/index.js';
import { transactionReport } from '@/lib/analytics.js';
import { ensureReportSchema } from '@/lib/reports.js';

test('analytics export carries actual dashboard metrics and all transactions with exact totals', () => {
  const sections = analyticsSections({ totals: { netSales: 1234.56, itemsSold: 8, missing: null }, primaryKpis: [{ label: 'Sales', value: 1234.56, comparison: { previous: 900 } }], recentTransactions: [{ bill_number: 'PARTIAL' }] }, [
    { bill_number: 'BILL-1', subtotal: 1200.25, final_total: 1000.25, cash_amount: 600.25, qr_amount: 400 },
    { bill_number: 'BILL-2', subtotal: 234.31, final_total: 234.31, cash_amount: 234.31 },
  ]);
  const totals = sections.find((s) => s.title === 'Overview · Totals');
  assert.equal(totals.rows.find((r) => r.metric === 'Net Sales').value, 1234.56);
  assert.equal(totals.rows.find((r) => r.metric === 'Missing').value, null);
  assert.equal(sections[0].rows.at(-1).final_total, 1234.56);
  assert.equal(sections[0].rows.at(-1).cash_amount, 834.56);
  assert.equal(sections.find((s) => s.title === 'Overview · Primary Kpis').rows[0]['Comparison · Previous'], 900);
  const csv = reportCsv('Restaurant Analytics', sections, [['Currency', 'NPR']]);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.match(csv, /Net Sales,1234.56/);
  assert.match(csv, /Missing,/);
  assert.doesNotMatch(csv, /PARTIAL|\[object Object\]/);
});

test('Excel report uses numeric cells, styled headers and safely escaped names', () => {
  const section = { title: 'Purchase items', columns: [{ key: 'name', label: 'Item' }, { key: 'amount', label: 'Amount', type: 'currency' }], rows: [{ name: 'Onion & garlic <fresh>', amount: 1234.56 }, { name: '=2+2', amount: -100 }, { name: 'TOTAL', amount: 1134.56 }] };
  const xml = reportWorkbook('Purchases', [section, section], [['Currency', 'NPR']]);
  assert.match(xml, /ss:Type="Number">1234.56/);
  assert.match(xml, /ss:Type="Number">-100/);
  assert.match(xml, /Onion &amp; garlic &lt;fresh&gt;/);
  assert.match(xml, /ss:Type="String">=2\+2/);
  assert.doesNotMatch(xml, /ss:Formula/);
  assert.match(xml, /ss:StyleID="Header"/);
  assert.match(xml, /ss:StyleID="Total"/);
  assert.match(xml, /ss:Name="Purchase items 2"/);
  const csv = reportCsv('Purchases', [section]);
  assert.match(csv, /'=2\+2,-100/);
});

test('purchase summaries include every actual item name, received quantity, purchase unit and rate', async () => {
  const file = path.join(os.tmpdir(), `purchase-export-${process.pid}-${Date.now()}.db`);
  const db = new PosDatabase(file);
  try {
    await ensureReportSchema(db);
    const item = (await db.run("INSERT INTO inventory_items(item_name,name,unit,purchase_unit) VALUES ('Fresh onion','Fresh onion','g','kg')")).lastInsertRowid;
    const other = (await db.run("INSERT INTO inventory_items(item_name,name,unit,purchase_unit) VALUES ('Cooking oil','Cooking oil','ml','l')")).lastInsertRowid;
    const invoice = (await db.run("INSERT INTO purchases(supplier,total) VALUES ('CSV supplier',350)")).lastInsertRowid;
    await db.run('INSERT INTO purchase_items(purchase_id,inventory_item_id,quantity_ordered,quantity_received,unit_cost,line_total) VALUES (?,?,2,2,100,200)', [invoice, item]);
    await db.run('INSERT INTO purchase_items(purchase_id,inventory_item_id,quantity_ordered,quantity_received,unit_cost,line_total) VALUES (?,?,1,1,150,150)', [invoice, other]);
    const summaries = await purchaseItemSummaries(db, [{ id: invoice }]);
    assert.equal(summaries.get(Number(invoice)), 'Fresh onion — 2 kg @ Rs 100.00; Cooking oil — 1 l @ Rs 150.00');
    const csv = reportCsv('Purchase report', [{ title: 'Invoices', columns: [{ key: 'items', label: 'Items' }], rows: [{ items: summaries.get(Number(invoice)) }] }]);
    assert.match(csv, /Fresh onion/);
    assert.match(csv, /Cooking oil/);
    const transactions = await transactionReport(db, { start: '2000-01-01', end: '2099-12-31' }, { exportAll: true });
    assert.ok(transactions.rows.length > 0, 'seeded bills must be exported');
    assert.ok(transactions.rows.some((row) => row.final_total > 0), 'real bill values must survive normalization');
  } finally { db.db.close(); fs.rmSync(file, { force: true }); }
});

test('transaction export surfaces query failures instead of silently downloading a zero report', async () => {
  const db = { driver: 'sqlite', get: async () => { throw new Error('Reporting database unavailable'); }, all: async () => { throw new Error('Reporting database unavailable'); } };
  await assert.rejects(transactionReport(db, { start: '2026-11-01', end: '2026-11-03' }, { exportAll: true }), /Reporting database unavailable/);
});

test('CSV remains Excel-readable with commas, Unicode names and exact decimal values', () => {
  const csv = reportCsv('Purchases', [{ title: 'Items', columns: [{ key: 'item', label: 'Item' }, { key: 'amount', label: 'Amount' }], rows: [{ item: 'प्याज, fresh', amount: 1500.25 }] }]);
  assert.match(csv, /"प्याज, fresh",1500.25/);
  assert.equal(parseCsv('\uFEFFItem,Amount\r\n"प्याज, fresh",1500.25').rows[0].Amount, '1500.25');
});
