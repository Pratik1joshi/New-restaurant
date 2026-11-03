import test from 'node:test';
import assert from 'node:assert/strict';
import Database from '@/lib/db/index.js';
import { ensureReportSchema } from '@/lib/reports.js';
import { ensureRecipeTables } from '@/lib/recipes.js';
import { openBusinessDay } from '@/lib/business-days.js';
import { applyStockChange } from '@/lib/inventory-ledger.js';
import {
  createKitchenUse, decideKitchenUse, ensureKitchenUseSchema, getKitchenUse, kitchenUseCostByType,
  listKitchenUse, previewKitchenUse, reverseKitchenUse,
} from '@/lib/kitchen-use.js';
import { ingredientDetail, ingredientUsageRows } from '@/lib/ingredient-usage.js';
import { buildSummaryReport } from '@/lib/summary-report.js';
import { nepalDateString } from '@/lib/report-dates.js';

if (!process.env.DATABASE_URL || !/^\/km_test_\d+_\d+$/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('Run using scripts/run-integration.mjs with an isolated local PostgreSQL server.');
const db = Database.getInstance();
const admin = { id: 1, role: 'admin', full_name: 'Test Admin' };
test.after(async () => { await Database.close(); });

test('PostgreSQL: kitchen use list, post, approve, reverse, reports and ingredient panel', async () => {
  await ensureReportSchema(db); await ensureRecipeTables(db); await ensureKitchenUseSchema(db);
  await openBusinessDay(db, { opening_cash: 1000 }, admin);
  const today = nepalDateString();
  const range = { start: today, end: today };

  // Empty list must load: this is the query that failed in production.
  const empty = await listKitchenUse(db, { from: today, to: today, page: 1, pageSize: 50 });
  assert.equal(empty.rows.length, 0);

  const flour = (await db.run(`INSERT INTO inventory_items(item_name,name,quantity,unit,consumption_unit,purchase_unit,conversion_factor,cost_per_unit)
    VALUES ('KU flour','KU flour',0,'g','g','kg',1000,0)`)).lastInsertRowid;
  await applyStockChange(db, { inventory_item_id: flour, quantity: 2000, change_type: 'purchase_receipt', unit_cost: 0.1 });
  const mc = (await db.run("INSERT INTO menu_categories(name) VALUES ('KU cat')")).lastInsertRowid;
  const dish = (await db.run("INSERT INTO menu_items(name,category_id,base_price) VALUES ('KU roti',?,50)", [mc])).lastInsertRowid;
  const recipe = (await db.run("INSERT INTO recipes(name,type,menu_item_id,yield_quantity,yield_unit) VALUES ('KU roti','menu_item',?,1,'portion')", [dish])).lastInsertRowid;
  await db.run("INSERT INTO recipe_items(recipe_id,raw_material_id,quantity,unit) VALUES (?,?,100,'g')", [recipe, flour]);

  const preview = await previewKitchenUse(db, { consumption_type: 'chef_tasting', source_mode: 'dish', menu_item_id: dish, quantity: 0.5 });
  assert.equal(preview.estimated_cost, 5);

  const tasting = await createKitchenUse(db, { consumption_type: 'chef_tasting', source_mode: 'dish', menu_item_id: dish, quantity: 0.5, reason: 'Taste', client_key: 'pg-ku-1' }, { actorId: 1, canApprove: true });
  assert.equal(tasting.status, 'posted');
  assert.equal(Number(tasting.posted_cost), 5);
  const again = await createKitchenUse(db, { consumption_type: 'chef_tasting', source_mode: 'dish', menu_item_id: dish, quantity: 0.5, reason: 'Taste', client_key: 'pg-ku-1' }, { actorId: 1, canApprove: true });
  assert.equal(again.id, tasting.id);

  const owner = await createKitchenUse(db, { consumption_type: 'owner_use', source_mode: 'ingredient', inventory_item_id: flour, quantity: 0.2, unit: 'kg', reason: 'Home' }, { actorId: 1, canApprove: false });
  assert.equal(owner.status, 'pending_approval');
  await decideKitchenUse(db, owner.id, { approve: true, actorId: 1 });
  assert.equal(Number((await db.get('SELECT quantity FROM inventory_items WHERE id=?', [flour])).quantity), 1750);

  await assert.rejects(
    createKitchenUse(db, { consumption_type: 'staff_meal', source_mode: 'ingredient', inventory_item_id: flour, quantity: 5000, reason: 'Too much' }, { actorId: 1, canApprove: true }),
    (e) => e.status === 409
  );

  const listed = await listKitchenUse(db, { from: today, to: today, page: 1, pageSize: 50, search: 'roti' });
  assert.equal(listed.rows.length, 1);
  assert.equal(String(listed.rows[0].use_date).slice(0, 10), today);
  assert.equal(listed.summary.posted_cost, 5);

  await reverseKitchenUse(db, tasting.id, { actorId: 1, reason: 'Mistake' });
  assert.equal((await getKitchenUse(db, tasting.id)).status, 'reversed');
  assert.equal(Number((await db.get('SELECT quantity FROM inventory_items WHERE id=?', [flour])).quantity), 1800);

  const cost = await kitchenUseCostByType(db, today, today);
  assert.equal(cost.chef_tasting, 0);
  assert.equal(cost.owner_use, 20);
  const balance = await db.get(`SELECT COALESCE(SUM(jl.debit),0) AS dr, COALESCE(SUM(jl.credit),0) AS cr FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_id
    WHERE je.source_type='kitchen_use' OR (je.source_type='reversal' AND je.source_id IN (SELECT id FROM journal_entries WHERE source_type='kitchen_use'))`);
  assert.equal(Number(balance.dr), Number(balance.cr));

  const row = (await ingredientUsageRows(db, range, {})).find((r) => r._record_id === flour);
  assert.equal(row.kitchen_use, 200);
  assert.equal(row.closing, 1800);
  const detail = await ingredientDetail(db, flour, range);
  assert.equal(detail.summary.kitchen_use, 200);
  assert.equal(detail.dishes.length, 1);

  const summary = await buildSummaryReport(db, range);
  assert.equal(summary.kitchen_use.owner_use, 20);
  assert.equal(summary.profit.kitchen_use, 0);

  const mixed = await createKitchenUse(db, { consumption_type: 'chef_tasting', reason: 'Mixed tasting', client_key: 'pg-ku-multiple', items: [
    { source_mode: 'recipe', recipe_id: recipe, quantity: 0.5 },
    { source_mode: 'dish', menu_item_id: dish, quantity: 0.5 },
    { source_mode: 'ingredient', inventory_item_id: flour, quantity: 0.1, unit: 'kg' },
  ] }, { actorId: 1, canApprove: true });
  assert.equal(mixed.status, 'posted');
  assert.equal(mixed.items.length, 3);
  assert.equal(mixed.components.length, 1);
  assert.equal(Number(mixed.posted_cost), 20);
  assert.equal(Number((await db.get('SELECT quantity FROM inventory_items WHERE id=?', [flour])).quantity), 1600);
  await reverseKitchenUse(db, mixed.id, { actorId: 1, reason: 'Undo mixed tasting' });
  assert.equal(Number((await db.get('SELECT quantity FROM inventory_items WHERE id=?', [flour])).quantity), 1800);
});
