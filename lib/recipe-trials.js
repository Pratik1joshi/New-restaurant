import { ensureSqliteTable } from '@/lib/db/ensure-sqlite-table.js';
import { ensureRecipeTables } from '@/lib/recipes.js';
import { createKitchenUse, ensureKitchenUseSchema, getKitchenUse, previewKitchenUse } from '@/lib/kitchen-use.js';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status, expose: true }); };

export async function ensureRecipeTrials(db) {
  await ensureRecipeTables(db);
  await ensureKitchenUseSchema(db);
  await ensureSqliteTable(db, `CREATE TABLE IF NOT EXISTS recipe_trial_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    studio TEXT NOT NULL CHECK (studio IN ('bar', 'kitchen')),
    status TEXT NOT NULL CHECK (status IN ('draft', 'planned', 'started')),
    ingredients TEXT NOT NULL,
    target_price REAL,
    instructions TEXT,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
}

export async function listRecipeTrials(db) {
  await ensureRecipeTrials(db);
  const rows = await db.all(`SELECT p.*, k.id AS consumption_id, k.status AS consumption_status, k.source_items AS actual_ingredients, k.notes AS tasting_notes
    FROM recipe_trial_plans p LEFT JOIN kitchen_use_records k ON k.client_key = ('recipe-trial-' || p.id)
    ORDER BY p.updated_at DESC, p.id DESC LIMIT 100`);
  return rows.map(({ actual_ingredients, ...row }) => ({ ...row, planned_ingredients: JSON.parse(row.ingredients), ingredients: JSON.parse(actual_ingredients || row.ingredients), status: row.consumption_id ? 'confirmed' : row.status }));
}

function ingredientInput(items) {
  if (!Array.isArray(items) || !items.length || items.length > 100) fail('Add between 1 and 100 ingredients.');
  return items.map((item) => {
    const id = Number(item.inventory_item_id);
    const quantity = Number(item.quantity);
    if (!Number.isSafeInteger(id) || id < 1 || !Number.isFinite(quantity) || quantity <= 0) fail('Choose an ingredient and enter a quantity greater than zero for every row.');
    return { source_mode: 'ingredient', inventory_item_id: id, quantity, unit: String(item.unit || '').trim() || null };
  });
}

export async function saveRecipeTrial(db, input, actorId) {
  await ensureRecipeTrials(db);
  const name = String(input.name || '').trim();
  if (!name || name.length > 160) fail('Enter a recipe name (up to 160 characters).');
  if (!['bar', 'kitchen'].includes(input.studio)) fail('Choose Bar Studio or Kitchen Studio.');
  if (!['draft', 'planned'].includes(input.status)) fail('Choose draft or planned.');
  const target = input.target_price === '' || input.target_price == null ? null : Number(input.target_price);
  if (target != null && (!Number.isFinite(target) || target < 0)) fail('Target selling price must be zero or more.');
  const items = ingredientInput(input.ingredients);
  // Validates inventory IDs and unit conversions, without requiring available stock.
  await previewKitchenUse(db, { consumption_type: 'recipe_testing', items });
  const key = String(input.client_key || '').trim();
  if (!key || key.length > 100) fail('A draft reference is required.');
  const values = [name, input.studio, input.status, JSON.stringify(items), target, String(input.instructions || '').trim().slice(0, 10000)];
  // Unique client_key also makes retrying a save safe.
  await db.run(`INSERT INTO recipe_trial_plans (client_key, name, studio, status, ingredients, target_price, instructions, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (client_key) DO NOTHING`, [key, ...values, actorId]);
  const existing = await db.get('SELECT * FROM recipe_trial_plans WHERE client_key = ?', [key]);
  if (Number(existing.created_by) !== Number(actorId)) fail('Only the creator can edit this trial.', 403);
  if (!['draft', 'planned'].includes(existing.status)) fail('This trial has already started. Record actual usage or create a new trial.', 409);
  const saved = await db.get(`UPDATE recipe_trial_plans SET name = ?, studio = ?, status = ?, ingredients = ?, target_price = ?, instructions = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status IN ('draft', 'planned') RETURNING *`, [...values, existing.id]);
  if (!saved) fail('This trial has already started. Reopen it to record actual usage.', 409);
  return { ...saved, ingredients: JSON.parse(saved.ingredients) };
}

export async function startRecipeTrial(db, id, actorId) {
  await ensureRecipeTrials(db);
  const plan = await db.get('SELECT * FROM recipe_trial_plans WHERE id = ?', [id]);
  if (!plan) fail('Trial not found.', 404);
  if (Number(plan.created_by) !== Number(actorId)) fail('Only the creator can start this trial.', 403);
  if (!['planned', 'started'].includes(plan.status)) fail('Plan this trial before starting it.', 409);
  await db.run("UPDATE recipe_trial_plans SET status = 'started', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'planned'", [id]);
  return { ...plan, status: 'started', ingredients: JSON.parse(plan.ingredients) };
}

export async function confirmRecipeTrial(db, id, input, actor) {
  await ensureRecipeTrials(db);
  const plan = await db.get('SELECT * FROM recipe_trial_plans WHERE id = ?', [id]);
  if (!plan) fail('Trial not found.', 404);
  if (Number(plan.created_by) !== Number(actor.actorId)) fail('Only the creator can confirm this trial.', 403);
  const key = `recipe-trial-${plan.id}`;
  const existing = await db.get('SELECT id FROM kitchen_use_records WHERE client_key = ?', [key]);
  if (existing) return getKitchenUse(db, existing.id);
  if (plan.status !== 'started') fail('Start the trial before confirming ingredient use.', 409);
  // The consumption record is the authoritative completion marker. Its unique key
  // ensures retries and concurrent confirmations never deduct stock twice.
  return createKitchenUse(db, {
    consumption_type: 'recipe_testing', client_key: key,
    items: ingredientInput(input.ingredients), reason: `Recipe trial: ${plan.name}`,
    notes: `${plan.studio === 'bar' ? 'Bar Studio' : 'Kitchen Studio'}\n${String(input.notes || '').trim()}`,
  }, actor);
}
