import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PosDatabase } from '../../lib/db/index.js';
import { ensureRecipeTables } from '../../lib/recipes.js';
import { openBusinessDay } from '../../lib/business-days.js';
import { applyStockChange } from '../../lib/inventory-ledger.js';
import {
  createKitchenUse, decideKitchenUse, ensureKitchenUseSchema, kitchenUseCostByType,
  previewKitchenUse, reverseKitchenUse, setKitchenUseThreshold,
} from '../../lib/kitchen-use.js';
import { ingredientUsageRows } from '../../lib/ingredient-usage.js';
import { nepalDateString } from '../../lib/report-dates.js';
import { ensureSplitPaymentSchema } from '../../lib/split-payments.js';

const actor = { id: 1, full_name: 'Admin', role: 'admin' };
const file = path.join(os.tmpdir(), `kitchen-use-${process.pid}-${Date.now()}.db`);
const db = new PosDatabase(file);
let ready;
let tag = 0;
test.after(() => { try { db.db.close(); } catch { /* ignore */ } fs.rmSync(file, { force: true }); });

async function setup() {
  ready ||= (async () => {
    await ensureRecipeTables(db);
    await openBusinessDay(db, { opening_cash: 100000 }, actor);
    await ensureKitchenUseSchema(db);
    await setKitchenUseThreshold(db, 1000);
  })();
  await ready;
  const n = ++tag;
  const addItem = async (label, { quantity = 1000, cost = 1, unit = 'g', purchaseUnit = 'kg', factor = 1000 } = {}) => {
    const id = (await db.run(
      `INSERT INTO inventory_items (item_name,name,quantity,unit,purchase_unit,consumption_unit,conversion_factor,cost_per_unit,is_archived)
       VALUES (?,?,0,?,?,?,?,?,0)`,
      [`${label} ${n}`, `${label} ${n}`, unit, purchaseUnit, unit, factor, cost]
    )).lastInsertRowid;
    if (quantity) await applyStockChange(db, { inventory_item_id: id, quantity, change_type: 'opening_balance', unit_cost: cost });
    return id;
  };
  const addDish = async (label, lines, yieldQty = 1) => {
    const cat = (await db.run(`INSERT INTO menu_categories (name) VALUES (?)`, [`Cat ${n} ${label}`])).lastInsertRowid;
    const dish = (await db.run(`INSERT INTO menu_items (name, category_id, base_price) VALUES (?, ?, 500)`, [`${label} ${n}`, cat])).lastInsertRowid;
    const recipe = (await db.run(`INSERT INTO recipes (name, type, menu_item_id, yield_quantity, yield_unit) VALUES (?, 'menu_item', ?, ?, 'portion')`, [`${label} ${n}`, dish, yieldQty])).lastInsertRowid;
    for (const [itemId, qty, unit] of lines) {
      await db.run(`INSERT INTO recipe_items (recipe_id, raw_material_id, quantity, unit) VALUES (?, ?, ?, ?)`, [recipe, itemId, qty, unit]);
    }
    return dish;
  };
  const qty = async (id) => Number((await db.get('SELECT quantity FROM inventory_items WHERE id=?', [id])).quantity);
  const cost = async (id) => Number((await db.get('SELECT cost_per_unit FROM inventory_items WHERE id=?', [id])).cost_per_unit);
  const journalLines = async (journalId) => db.all(
    `SELECT a.code, jl.debit, jl.credit FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE jl.journal_id = ? ORDER BY a.code`,
    [journalId]
  );
  return { addItem, addDish, qty, cost, journalLines };
}

const record = (input, opts = { actorId: actor.id, canApprove: true }) => createKitchenUse(db, { reason: 'Tasting before service', ...input }, opts);

for (const [type, account] of [['staff_meal', '5082'], ['owner_use', '3030']]) {
  test(`${type}: multiple dishes and ingredients deduct stock without sales, bills or payments`, async () => {
    const { addItem, addDish, qty, journalLines } = await setup();
    await ensureSplitPaymentSchema(db);
    const rice = await addItem(`${type} rice`, { quantity: 2000, cost: 0.1 });
    const oil = await addItem(`${type} oil`, { quantity: 1000, cost: 0.2 });
    const lunch = await addDish(`${type} lunch`, [[rice, 100, 'g'], [oil, 10, 'g']]);
    const side = await addDish(`${type} side`, [[rice, 50, 'g']]);
    const salesSnapshot = async () => ({
      orders: await db.get('SELECT COUNT(*) AS n FROM orders'),
      bills: await db.get('SELECT COUNT(*) AS n, COALESCE(SUM(grand_total),0) AS sales FROM bills'),
      payments: await db.get('SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS amount FROM bill_payments'),
      allocations: await db.get('SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS amount FROM bill_payment_allocations'),
      revenue: await db.get("SELECT COALESCE(SUM(jl.credit-jl.debit),0) AS amount FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id WHERE a.code='4010'"),
    });
    const before = await salesSnapshot();
    const meal = await record({ consumption_type: type, reason: 'Lunch for staff or family', items: [
      { source_mode: 'dish', menu_item_id: lunch, quantity: 2 },
      { source_mode: 'dish', menu_item_id: side, quantity: 1 },
      { source_mode: 'ingredient', inventory_item_id: rice, quantity: 25, unit: 'g' },
      { source_mode: 'ingredient', inventory_item_id: oil, quantity: 5, unit: 'g' },
    ] });
    assert.equal(meal.status, 'posted');
    assert.equal(meal.items.length, 4);
    assert.equal(await qty(rice), 1725);
    assert.equal(await qty(oil), 975);
    assert.equal(Number(meal.posted_cost), 32.5);
    assert.ok(meal.reference_number);
    assert.equal(Number(meal.recorded_by), actor.id);
    const lines = await journalLines(meal.journal_id);
    assert.equal(Number(lines.find((line) => line.code === account).debit), 32.5);
    assert.deepEqual(await salesSnapshot(), before);
    await reverseKitchenUse(db, meal.id, { actorId: actor.id, reason: 'Correct meal entry' });
    assert.equal(await qty(rice), 2000);
    assert.equal(await qty(oil), 1000);
    assert.deepEqual(await salesSnapshot(), before);
  });
}

test('mixed tasting combines shared stock, posts once, retries once and reverses all items', async () => {
  const { addItem, addDish, qty } = await setup();
  const flour = await addItem('Mixed flour', { quantity: 1000, cost: 0.5 });
  const oil = await addItem('Mixed oil', { quantity: 500, cost: 0.2 });
  const dish = await addDish('Mixed bread', [[flour, 100, 'g'], [oil, 10, 'g']]);
  const recipe = await db.get('SELECT id FROM recipes WHERE menu_item_id = ?', [dish]);
  const input = { consumption_type: 'chef_tasting', client_key: 'mixed-tasting-once', items: [
    { source_mode: 'dish', menu_item_id: dish, quantity: 0.5 },
    { source_mode: 'ingredient', inventory_item_id: flour, quantity: 25 },
    { source_mode: 'recipe', recipe_id: recipe.id, quantity: 0.5 },
  ] };
  const preview = await previewKitchenUse(db, input);
  assert.equal(preview.components.length, 2);
  assert.equal(preview.estimated_cost, 64.5);
  assert.equal(await qty(flour), 1000);
  const result = await record(input);
  assert.equal(result.items.length, 3);
  assert.equal(result.components.length, 2);
  assert.equal(Number(result.posted_cost), 64.5);
  assert.equal(await qty(flour), 875);
  assert.equal(await qty(oil), 490);
  assert.equal((await record(input)).id, result.id);
  assert.equal(await qty(flour), 875);
  await reverseKitchenUse(db, result.id, { actorId: actor.id, reason: 'Correct mixed tasting' });
  assert.equal(await qty(flour), 1000);
  assert.equal(await qty(oil), 500);
});

test('combined tasting shortage is detected even when each line fits individually', async () => {
  const { addItem, qty } = await setup();
  const item = await addItem('Shared tasting stock', { quantity: 100 });
  const input = { consumption_type: 'chef_tasting', items: [
    { source_mode: 'ingredient', inventory_item_id: item, quantity: 60 },
    { source_mode: 'ingredient', inventory_item_id: item, quantity: 60 },
  ] };
  assert.equal((await previewKitchenUse(db, input)).short_items.length, 1);
  const before = Number((await db.get('SELECT COUNT(*) AS n FROM kitchen_use_records')).n);
  await assert.rejects(record(input), (e) => e.status === 409);
  assert.equal(await qty(item), 100);
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM kitchen_use_records')).n), before);
});

test('approval threshold applies to the whole tasting and recipe-first selection survives approval', async () => {
  const { addItem, addDish, qty } = await setup();
  const item = await addItem('Approval tasting stock', { quantity: 2000, cost: 1 });
  const dish = await addDish('Approval tasting recipe', [[item, 1, 'g']]);
  const recipe = await db.get('SELECT id FROM recipes WHERE menu_item_id = ?', [dish]);
  const result = await record({ consumption_type: 'chef_tasting', items: [
    { source_mode: 'recipe', recipe_id: recipe.id, quantity: 600 },
    { source_mode: 'ingredient', inventory_item_id: item, quantity: 600 },
  ] }, { actorId: actor.id, canApprove: false });
  assert.equal(result.status, 'pending_approval');
  assert.equal(await qty(item), 2000);
  await decideKitchenUse(db, result.id, { approve: true, actorId: actor.id });
  assert.equal(await qty(item), 800);
});

test('ingredient tasting deducts stock, snapshots cost and posts Dr 5080 / Cr 5015 only', async () => {
  const { addItem, qty, journalLines } = await setup();
  const gravy = await addItem('Gravy', { quantity: 2000, cost: 0.5, unit: 'ml', purchaseUnit: 'l' });
  const r = await record({ consumption_type: 'chef_tasting', source_mode: 'ingredient', inventory_item_id: gravy, quantity: 25 });
  assert.equal(r.status, 'posted');
  assert.equal(await qty(gravy), 1975);
  assert.equal(Number(r.posted_cost), 12.5);
  assert.equal(r.components.length, 1);
  assert.equal(Number(r.components[0].unit_cost), 0.5);
  const lines = await journalLines(r.journal_id);
  assert.deepEqual(lines.map((l) => [l.code, Number(l.debit), Number(l.credit)]), [['5015', 0, 12.5], ['5080', 12.5, 0]]);
  const move = await db.get('SELECT change_type, quantity_changed FROM stock_movements WHERE id = ?', [r.components[0].movement_id]);
  assert.deepEqual([move.change_type, Number(move.quantity_changed)], ['kitchen_use', -25]);
});

test('half a portion of a recipe dish deducts half of every ingredient', async () => {
  const { addItem, addDish, qty } = await setup();
  const chicken = await addItem('Chicken', { quantity: 1000, cost: 0.6 });
  const onion = await addItem('Onion', { quantity: 500, cost: 0.08 });
  const dish = await addDish('Curry', [[chicken, 200, 'g'], [onion, 50, 'g']]);
  const r = await record({ consumption_type: 'staff_meal', source_mode: 'dish', menu_item_id: dish, quantity: 0.5, reason: 'Lunch' });
  assert.equal(await qty(chicken), 900);
  assert.equal(await qty(onion), 475);
  assert.equal(Number(r.posted_cost), 62); // 100g × 0.6 + 25g × 0.08
  assert.equal(r.unit, 'portion');
});

test('a quantity in the purchase unit converts to the stock unit', async () => {
  const { addItem, qty } = await setup();
  const rice = await addItem('Rice', { quantity: 5000, cost: 0.1 });
  await record({ consumption_type: 'recipe_testing', source_mode: 'ingredient', inventory_item_id: rice, quantity: 0.2, unit: 'kg', reason: 'New biryani' });
  assert.equal(await qty(rice), 4800);
});

test('not enough stock is refused and nothing is written', async () => {
  const { addItem, qty } = await setup();
  const milk = await addItem('Milk', { quantity: 50, cost: 0.1, unit: 'ml', purchaseUnit: 'l' });
  const before = Number((await db.get('SELECT COUNT(*) AS n FROM kitchen_use_records')).n);
  await assert.rejects(
    record({ consumption_type: 'chef_tasting', source_mode: 'ingredient', inventory_item_id: milk, quantity: 100 }),
    (error) => error.status === 409 && /Not enough/.test(error.message)
  );
  assert.equal(await qty(milk), 50);
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM kitchen_use_records')).n), before);
});

test('the same client key twice is one posting', async () => {
  const { addItem, qty } = await setup();
  const oil = await addItem('Oil', { quantity: 1000, cost: 0.25, unit: 'ml', purchaseUnit: 'l' });
  const input = { consumption_type: 'chef_tasting', source_mode: 'ingredient', inventory_item_id: oil, quantity: 10, client_key: `dup-${tag}` };
  const [a, b] = await Promise.all([record(input), record(input)]);
  assert.equal(a.id, b.id);
  assert.equal(await qty(oil), 990);
  const moves = await db.all(`SELECT id FROM stock_movements WHERE change_type='kitchen_use' AND reference_id = ?`, [String(a.id)]);
  assert.equal(moves.length, 1);
});

test('owner use waits for approval without touching stock, then posts to Owner Drawings', async () => {
  const { addItem, qty, journalLines } = await setup();
  const momo = await addItem('Momo', { quantity: 100, cost: 15, unit: 'pcs', purchaseUnit: 'pcs', factor: 1 });
  const pending = await record({ consumption_type: 'owner_use', source_mode: 'ingredient', inventory_item_id: momo, quantity: 10, reason: 'Family dinner' }, { actorId: actor.id, canApprove: false });
  assert.equal(pending.status, 'pending_approval');
  assert.equal(await qty(momo), 100);
  assert.equal(pending.journal_id, null);
  const posted = await decideKitchenUse(db, pending.id, { approve: true, actorId: actor.id });
  assert.equal(posted.status, 'posted');
  assert.equal(await qty(momo), 90);
  const lines = await journalLines(posted.journal_id);
  assert.deepEqual(lines.map((l) => [l.code, Number(l.debit), Number(l.credit)]), [['3030', 150, 0], ['5015', 0, 150]]);
  await assert.rejects(decideKitchenUse(db, pending.id, { approve: true, actorId: actor.id }), (e) => e.status === 409);
});

test('cost above the approval limit waits; rejection changes nothing', async () => {
  const { addItem, qty } = await setup();
  const meat = await addItem('Mutton', { quantity: 5000, cost: 1.2 });
  const pending = await record({ consumption_type: 'recipe_testing', source_mode: 'ingredient', inventory_item_id: meat, quantity: 1000, reason: 'Trial' }, { actorId: actor.id, canApprove: false });
  assert.equal(pending.status, 'pending_approval');
  await assert.rejects(decideKitchenUse(db, pending.id, { approve: false, actorId: actor.id }), (e) => e.status === 400);
  const rejected = await decideKitchenUse(db, pending.id, { approve: false, actorId: actor.id, note: 'Too much' });
  assert.equal(rejected.status, 'rejected');
  assert.equal(await qty(meat), 5000);
});

test('reversal restores stock at the original cost, mirrors the journal, and only once', async () => {
  const { addItem, qty, cost, journalLines } = await setup();
  const paneer = await addItem('Paneer', { quantity: 1000, cost: 0.8 });
  const r = await record({ consumption_type: 'guest_sample', source_mode: 'ingredient', inventory_item_id: paneer, quantity: 100, reason: 'Sample for regulars' });
  // A later delivery at a new price must not change the posted snapshot.
  await applyStockChange(db, { inventory_item_id: paneer, quantity: 900, change_type: 'purchase_receipt', unit_cost: 1.0 });
  const avgBefore = await cost(paneer);
  const reversed = await reverseKitchenUse(db, r.id, { actorId: actor.id, reason: 'Entered twice' });
  assert.equal(reversed.status, 'reversed');
  assert.equal(Number(reversed.posted_cost), 80);
  assert.equal(await qty(paneer), 1900);
  // 1800 @ avg + 100 back @ 0.8
  assert.ok(Math.abs(await cost(paneer) - (1800 * avgBefore + 100 * 0.8) / 1900) < 1e-9);
  const mirror = await journalLines(reversed.reversal_journal_id);
  assert.deepEqual(mirror.map((l) => [l.code, Number(l.debit), Number(l.credit)]), [['5015', 80, 0], ['5083', 0, 80]]);
  await assert.rejects(reverseKitchenUse(db, r.id, { actorId: actor.id, reason: 'again' }), (e) => e.status === 409);
  const byType = await kitchenUseCostByType(db, nepalDateString(), nepalDateString());
  assert.ok(byType.guest_sample >= 0);
});

test('bad input is refused', async () => {
  const { addItem } = await setup();
  const salt = await addItem('Salt', { quantity: 100 });
  for (const quantity of [0, -5, 'abc']) {
    await assert.rejects(record({ consumption_type: 'chef_tasting', source_mode: 'ingredient', inventory_item_id: salt, quantity }), (e) => e.status === 400);
  }
  await assert.rejects(record({ consumption_type: 'nope', source_mode: 'ingredient', inventory_item_id: salt, quantity: 1 }), (e) => e.status === 400);
  await assert.rejects(record({ consumption_type: 'chef_tasting', source_mode: 'ingredient', inventory_item_id: salt, quantity: 1, reason: '  ' }), (e) => e.status === 400);
  await assert.rejects(record({ consumption_type: 'chef_tasting', source_mode: 'ingredient', inventory_item_id: salt, quantity: 1, unit: 'banana' }), (e) => e.status === 400);
});

test('preview never moves stock and flags shortages', async () => {
  const { addItem, qty } = await setup();
  const butter = await addItem('Butter', { quantity: 30, cost: 1 });
  const preview = await previewKitchenUse(db, { consumption_type: 'staff_meal', source_mode: 'ingredient', inventory_item_id: butter, quantity: 40 });
  assert.deepEqual(preview.short_items, [`Butter ${tag}`]);
  assert.equal(preview.estimated_cost, 40);
  assert.equal(await qty(butter), 30);
});

test('ingredient usage report puts kitchen use in its own column, net of reversals', async () => {
  const { addItem } = await setup();
  const ginger = await addItem('Ginger', { quantity: 500, cost: 0.2 });
  const a = await record({ consumption_type: 'chef_tasting', source_mode: 'ingredient', inventory_item_id: ginger, quantity: 20 });
  await record({ consumption_type: 'chef_tasting', source_mode: 'ingredient', inventory_item_id: ginger, quantity: 5 });
  await reverseKitchenUse(db, a.id, { actorId: actor.id, reason: 'Mistake' });
  const today = nepalDateString();
  const row = (await ingredientUsageRows(db, { start: today, end: today }, {})).find((r) => r._record_id === ginger);
  assert.equal(row.kitchen_use, 5);
  assert.equal(row.used, 0);
  assert.equal(row.other, 500); // the opening entry
  assert.equal(row.closing, 495);
});

test('two requests racing for stock that covers only one: exactly one posts', async () => {
  const { addItem, qty } = await setup();
  const cheese = await addItem('Cheese', { quantity: 100, cost: 2 });
  const input = (key) => ({ consumption_type: 'staff_meal', source_mode: 'ingredient', inventory_item_id: cheese, quantity: 80, reason: 'Lunch', client_key: `${key}-${tag}` });
  const results = await Promise.allSettled([record(input('a')), record(input('b'))]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected' && r.reason.status === 409).length, 1);
  assert.equal(await qty(cheese), 20);
});
