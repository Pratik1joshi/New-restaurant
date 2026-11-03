import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PosDatabase } from '../../lib/db/index.js';
import { openBusinessDay } from '../../lib/business-days.js';
import { applyStockChange } from '../../lib/inventory-ledger.js';
import { hideCosts } from '../../lib/kitchen-use.js';
import { confirmRecipeTrial, ensureRecipeTrials, listRecipeTrials, saveRecipeTrial, startRecipeTrial } from '../../lib/recipe-trials.js';

const file = path.join(os.tmpdir(), `recipe-trials-${process.pid}-${Date.now()}.db`);
const db = new PosDatabase(file);
const actor = { actorId: 1, canApprove: true };
let initialized;
let sequence = 0;
test.after(() => { db.db.close(); fs.rmSync(file, { force: true }); });

async function fixture(quantity = 1000) {
  initialized ||= (async () => {
    await ensureRecipeTrials(db);
    await openBusinessDay(db, { opening_cash: 0 }, { id: 1, role: 'admin', full_name: 'Admin' });
  })();
  await initialized;
  const tag = ++sequence;
  const id = (await db.run(`INSERT INTO inventory_items (item_name, name, quantity, unit, consumption_unit, purchase_unit, conversion_factor, cost_per_unit, is_archived)
    VALUES (?, ?, 0, 'ml', 'ml', 'liter', 1000, 2.5, 0)`, [`Juice ${tag}`, `Juice ${tag}`])).lastInsertRowid;
  await applyStockChange(db, { inventory_item_id: id, quantity, change_type: 'opening_balance', unit_cost: 2.5 });
  const input = { client_key: `trial-${tag}`, name: `Sunset ${tag}`, studio: 'bar', status: 'draft', ingredients: [{ inventory_item_id: id, quantity: 40, unit: 'ml' }], target_price: 450, instructions: 'Shake with ice.' };
  const stock = async () => Number((await db.get('SELECT quantity FROM inventory_items WHERE id = ?', [id])).quantity);
  return { id, input, stock };
}

test('draft, plan and start preserve the named recipe and never consume stock or create accounting', async () => {
  const { input, stock } = await fixture();
  const before = await db.get('SELECT COUNT(*) AS n FROM journal_entries');
  const draft = await saveRecipeTrial(db, input, 1);
  const again = await saveRecipeTrial(db, input, 1);
  assert.equal(draft.id, again.id);
  assert.equal(draft.name, input.name);
  assert.equal(Number(draft.target_price), 450);
  assert.equal(draft.ingredients[0].unit, 'ml');
  await assert.rejects(startRecipeTrial(db, draft.id, 1), (e) => e.status === 409);
  await saveRecipeTrial(db, { ...input, status: 'planned' }, 1);
  assert.equal((await startRecipeTrial(db, draft.id, 1)).status, 'started');
  assert.equal(await stock(), 1000);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM journal_entries')).n, before.n);
  await assert.rejects(saveRecipeTrial(db, input, 1), (e) => e.status === 409);
});

test('confirmation consumes actual quantities once, preserves planned quantities, and keeps the recipe name', async () => {
  const { id, input, stock } = await fixture();
  const plan = await saveRecipeTrial(db, { ...input, status: 'planned' }, 1);
  await assert.rejects(confirmRecipeTrial(db, plan.id, { ingredients: input.ingredients }, actor), (e) => e.status === 409);
  await startRecipeTrial(db, plan.id, 1);
  const actual = { ingredients: [{ inventory_item_id: id, quantity: 0.06, unit: 'liter' }], notes: 'Too sweet; reduce syrup.' };
  const record = await confirmRecipeTrial(db, plan.id, actual, actor);
  assert.equal(record.status, 'posted');
  assert.equal(Number(record.posted_cost), 150);
  assert.ok(record.reason.includes(input.name));
  assert.equal(await stock(), 940);
  assert.equal((await confirmRecipeTrial(db, plan.id, actual, actor)).id, record.id);
  assert.equal(await stock(), 940);
  const saved = (await listRecipeTrials(db)).find((t) => t.id === plan.id);
  assert.equal(saved.status, 'confirmed');
  assert.equal(saved.planned_ingredients[0].quantity, 40);
  assert.equal(saved.ingredients[0].quantity, 0.06);
  assert.ok(saved.tasting_notes.includes('Too sweet'));
});

test('shortages can be drafted but confirmation fails without any partial deduction', async () => {
  const { input, stock } = await fixture(20);
  const plan = await saveRecipeTrial(db, { ...input, status: 'planned' }, 1);
  await startRecipeTrial(db, plan.id, 1);
  await assert.rejects(confirmRecipeTrial(db, plan.id, { ingredients: input.ingredients }, actor), (e) => e.status === 409);
  assert.equal(await stock(), 20);
  assert.equal((await listRecipeTrials(db)).find((t) => t.id === plan.id).status, 'started');
});

test('trial validation and creator ownership protect saved definitions', async () => {
  const { input } = await fixture();
  await assert.rejects(saveRecipeTrial(db, { ...input, name: ' ' }, 1), (e) => e.status === 400);
  await assert.rejects(saveRecipeTrial(db, { ...input, target_price: -1 }, 1), (e) => e.status === 400);
  await assert.rejects(saveRecipeTrial(db, { ...input, ingredients: [{ ...input.ingredients[0], unit: 'banana' }] }, 1), (e) => e.status === 400);
  const draft = await saveRecipeTrial(db, input, 1);
  await assert.rejects(saveRecipeTrial(db, input, 2), (e) => e.status === 403);
  await assert.rejects(startRecipeTrial(db, draft.id, 2), (e) => e.status === 403);
  await assert.rejects(confirmRecipeTrial(db, draft.id, { ingredients: input.ingredients }, { ...actor, actorId: 2 }), (e) => e.status === 403);
  assert.deepEqual(hideCosts({ ingredients: [{ id: 1, unit_cost: 2.5, unit: 'ml' }] }), { ingredients: [{ id: 1, unit: 'ml' }] });
});

test('trial approval uses the existing stock controls and concurrent retries return one record', async () => {
  const { id, input, stock } = await fixture(2000);
  const plan = await saveRecipeTrial(db, { ...input, status: 'planned' }, 1);
  await startRecipeTrial(db, plan.id, 1);
  const actual = { ingredients: [{ inventory_item_id: id, quantity: 500, unit: 'ml' }] };
  const results = await Promise.all([
    confirmRecipeTrial(db, plan.id, actual, { ...actor, canApprove: false }),
    confirmRecipeTrial(db, plan.id, actual, { ...actor, canApprove: false }),
  ]);
  assert.equal(results[0].id, results[1].id);
  assert.equal(results[0].status, 'pending_approval');
  assert.equal(await stock(), 2000);
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM kitchen_use_records WHERE client_key = ?', [`recipe-trial-${plan.id}`])).n), 1);
});
