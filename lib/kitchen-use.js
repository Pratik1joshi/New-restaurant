/**
 * Kitchen Use — stock eaten without a sale: chef tasting, recipe testing, staff
 * meals, owner/family use and guest samples given outside an order.
 *
 * Nothing new is invented here. Stock leaves through applyStockChange (the one
 * write path, moving-average cost), dishes resolve exactly like a sale (direct
 * stock link, else recipe), journals go through postJournal / reverseJournal,
 * numbers come from nextDocumentNumber.
 *
 * Accounting follows the existing PERIODIC model: purchases are expensed to
 * 5010 when bought and Inventory (1200) is never capitalised. So a posting
 * moves cost OUT of purchases into the account that says what it was for:
 *
 *   Dr 5080/5081/5082/5083 (or 3030 Owner Drawings)   Cr 5015 Purchases Used in Kitchen
 *
 * Business-use types leave profit unchanged (the money was already spent) but
 * show where it went; owner use RAISES profit because goods taken home are a
 * drawing, not a business cost. Cash, sales and Inventory are never touched.
 *
 * Lifecycle: pending_approval -> posted | rejected, posted -> reversed. Stock
 * and journal change only at the posting event, inside one transaction.
 */

import { ensureSqliteTable } from '@/lib/db/ensure-sqlite-table.js';
import { ensureColumn } from '@/lib/db/schema-helpers.js';
import { applyStockChange, toConsumption } from '@/lib/inventory-ledger.js';
import { explodeRecipe, getRecipeByMenuItemId } from '@/lib/recipes.js';
import { resolveDirectMenuStockLink, normalizeMenuStockUsage, recipeMultiplier } from '@/lib/stock.js';
import { resolveConversionFactor, listUnitConversions } from '@/lib/unit-conversions.js';
import { ensureAccountingSchema, postJournal } from '@/lib/accounting.js';
import { reverseJournal } from '@/lib/accounting-corrections.js';
import { currentBusinessDayId } from '@/lib/business-days.js';
import { nextDocumentNumber } from '@/lib/document-numbers.js';
import { paginateQuery } from '@/lib/paginate.js';
import { isPermissionAllowedSync } from '@/lib/permissions.js';

export const KITCHEN_USE_TYPES = {
  chef_tasting: { label: 'Chef Tasting', account: '5080' },
  recipe_testing: { label: 'Recipe Testing', account: '5081' },
  staff_meal: { label: 'Staff Meal', account: '5082' },
  owner_use: { label: 'Owner / Family Use', account: '3030' },
  guest_sample: { label: 'Guest Sample', account: '5083' },
};
export const KITCHEN_USE_CONTRA_ACCOUNT = '5015';
const STATUSES = ['pending_approval', 'posted', 'rejected', 'reversed'];
const THRESHOLD_KEY = 'kitchen_use_approval_threshold';
const DEFAULT_THRESHOLD = 1000;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const round6 = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;
const fail = (message, status = 400, extra = {}) => { throw Object.assign(new Error(message), { status, expose: true, ...extra }); };
const sqlList = (values) => values.map((v) => `'${v}'`).join(',');

export async function ensureKitchenUseSchema(db) {
  await ensureAccountingSchema(db);
  await ensureSqliteTable(db, `CREATE TABLE IF NOT EXISTS kitchen_use_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference_number TEXT NOT NULL UNIQUE,
    client_key TEXT UNIQUE,
    consumption_type TEXT NOT NULL CHECK (consumption_type IN (${sqlList(Object.keys(KITCHEN_USE_TYPES))})),
    source_mode TEXT NOT NULL CHECK (source_mode IN ('dish','ingredient')),
    menu_item_id INTEGER REFERENCES menu_items(id),
    inventory_item_id INTEGER REFERENCES inventory_items(id),
    item_label TEXT NOT NULL,
    quantity REAL NOT NULL CHECK (quantity > 0),
    unit TEXT,
    status TEXT NOT NULL CHECK (status IN (${sqlList(STATUSES)})),
    reason TEXT NOT NULL,
    notes TEXT,
    estimated_cost REAL NOT NULL DEFAULT 0,
    posted_cost REAL,
    business_day_id INTEGER,
    journal_id INTEGER,
    reversal_journal_id INTEGER,
    recorded_by INTEGER REFERENCES users(id),
    approved_by INTEGER REFERENCES users(id),
    approved_at DATETIME,
    posted_at DATETIME,
    decided_note TEXT,
    reversed_by INTEGER REFERENCES users(id),
    reversed_at DATETIME,
    reversal_reason TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK ((source_mode = 'dish' AND menu_item_id IS NOT NULL) OR (source_mode = 'ingredient' AND inventory_item_id IS NOT NULL)),
    CHECK (status IN ('pending_approval','rejected') OR posted_at IS NOT NULL)
  )`);
  await ensureSqliteTable(db, `CREATE TABLE IF NOT EXISTS kitchen_use_components (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kitchen_use_id INTEGER NOT NULL REFERENCES kitchen_use_records(id),
    inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id),
    item_name TEXT NOT NULL,
    quantity REAL NOT NULL CHECK (quantity > 0),
    unit TEXT,
    unit_cost REAL NOT NULL DEFAULT 0,
    total_cost REAL NOT NULL DEFAULT 0,
    movement_id INTEGER,
    reversal_movement_id INTEGER,
    UNIQUE (kitchen_use_id, inventory_item_id)
  )`);
  await ensureSqliteTable(db, 'CREATE INDEX IF NOT EXISTS idx_kitchen_use_status_day ON kitchen_use_records (status, business_day_id)');
  await ensureSqliteTable(db, 'CREATE INDEX IF NOT EXISTS idx_kitchen_use_created ON kitchen_use_records (created_at)');
  await ensureColumn(db, 'kitchen_use_records', 'source_items', 'TEXT');
}

export async function kitchenUseThreshold(db) {
  const row = await db.get('SELECT setting_value FROM system_settings WHERE setting_key = ?', [THRESHOLD_KEY]).catch(() => null);
  const value = Number(row?.setting_value);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_THRESHOLD;
}

export async function setKitchenUseThreshold(db, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) fail('Approval limit must be zero or more.');
  const existing = await db.get('SELECT id FROM system_settings WHERE setting_key = ?', [THRESHOLD_KEY]);
  if (existing) await db.run('UPDATE system_settings SET setting_value = ?, updated_at = CURRENT_TIMESTAMP WHERE setting_key = ?', [String(n), THRESHOLD_KEY]);
  else await db.run('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)', [THRESHOLD_KEY, String(n)]);
  return n;
}

/** Owner use always needs a second pair of eyes; anything else only above the limit. */
export function needsApproval(type, cost, threshold) {
  return type === 'owner_use' || (threshold > 0 && cost > threshold);
}

function validateInput(input) {
  const type = String(input?.consumption_type || '');
  if (!KITCHEN_USE_TYPES[type]) fail('Choose what this kitchen use was for.');
  const mode = ['ingredient', 'dish', 'recipe'].includes(input?.source_mode) ? input.source_mode : null;
  if (!mode) fail('Choose a dish or an ingredient.');
  const quantity = Number(input?.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) fail('Quantity must be more than zero.');
  const id = Number(mode === 'recipe' ? input.recipe_id : mode === 'dish' ? input.menu_item_id : input.inventory_item_id);
  if (!Number.isSafeInteger(id) || id < 1) fail(mode === 'dish' ? 'Choose a dish.' : 'Choose an ingredient.');
  return { type, mode, quantity, id, unit: input?.unit ? String(input.unit).trim() : null };
}

/**
 * What a kitchen use consumes, in each item's stock (consumption) unit — the
 * same resolution a sale uses, so the two can never disagree.
 * @returns {{ label: string, unit: string|null, deltas: Map<number, number> }}
 */
async function resolveConsumption(db, { mode, id, quantity, unit }) {
  if (mode === 'recipe') {
    const recipe = await db.get('SELECT * FROM recipes WHERE id = ? AND COALESCE(is_active, 1) = 1', [id]);
    if (!recipe) fail('That recipe was not found.', 404);
    const deltas = await explodeRecipe(db, id, await recipeMultiplier(db, recipe, quantity));
    for (const [key, value] of deltas) {
      if (!(value > 0)) deltas.delete(key);
      else deltas.set(key, round6(value));
    }
    if (!deltas.size) fail('This recipe has no ingredients to deduct.', 409);
    return { label: recipe.name, unit: recipe.yield_unit || 'portion', deltas };
  }
  if (mode === 'ingredient') {
    const item = await db.get('SELECT * FROM inventory_items WHERE id = ? AND COALESCE(is_archived, 0) = 0', [id]);
    if (!item) fail('That ingredient was not found.', 404);
    const base = item.consumption_unit || item.unit || null;
    let amount = quantity;
    if (unit && base && unit !== base) {
      if (unit === item.purchase_unit) amount = toConsumption(item, quantity, 'purchase');
      else {
        const factor = resolveConversionFactor(unit, base, await listUnitConversions(db));
        if (factor == null) fail(`No conversion from ${unit} to ${base} for ${item.item_name}.`);
        amount = quantity * factor;
      }
    }
    return { label: item.item_name || item.name, unit: unit || base, deltas: new Map([[item.id, round6(amount)]]) };
  }

  const dish = await db.get('SELECT id, name FROM menu_items WHERE id = ?', [id]);
  if (!dish) fail('That dish was not found.', 404);
  const direct = await resolveDirectMenuStockLink(db, id);
  if (direct) {
    return { label: dish.name, unit: 'portion', deltas: new Map([[direct.id, round6(normalizeMenuStockUsage(direct.menu_stock_usage) * quantity)]]) };
  }
  const recipe = await getRecipeByMenuItemId(db, id);
  if (!recipe) fail(`${dish.name} has no recipe or stock link, so there is nothing to deduct. Record the ingredients instead.`, 409);
  const deltas = await explodeRecipe(db, recipe.id, await recipeMultiplier(db, recipe, quantity));
  for (const [key, value] of deltas) deltas.set(key, round6(value));
  for (const [key, value] of deltas) if (!(value > 0)) deltas.delete(key);
  if (!deltas.size) fail(`${dish.name}'s recipe has no ingredients to deduct.`, 409);
  return { label: dish.name, unit: 'portion', deltas };
}

/** Ingredient breakdown valued at today's moving-average cost (informational). */
async function priceComponents(db, deltas) {
  const out = [];
  for (const [inventoryItemId, quantity] of deltas) {
    const item = await db.get('SELECT id, item_name, name, quantity, cost_per_unit, consumption_unit, unit FROM inventory_items WHERE id = ?', [inventoryItemId]);
    if (!item) fail('A recipe ingredient is missing from inventory.', 409);
    const unitCost = Number(item.cost_per_unit) || 0;
    out.push({
      inventory_item_id: item.id,
      item_name: item.item_name || item.name,
      unit: item.consumption_unit || item.unit || '',
      quantity,
      available: round6(item.quantity),
      short: quantity > Number(item.quantity || 0) + 1e-9,
      unit_cost: unitCost,
      total_cost: round2(quantity * unitCost),
    });
  }
  return out;
}

async function resolveItems(db, input) {
  const inputs = input.items === undefined ? [input] : input.items;
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > 100) fail('Add between 1 and 100 items.');
  const deltas = new Map();
  const items = [];
  for (const line of inputs) {
    const parsed = validateInput({ ...line, consumption_type: input.consumption_type });
    const resolved = await resolveConsumption(db, parsed);
    items.push({ source_mode: parsed.mode, consumption_type: parsed.type,
      ...(parsed.mode === 'dish' ? { menu_item_id: parsed.id } : parsed.mode === 'recipe' ? { recipe_id: parsed.id } : { inventory_item_id: parsed.id }),
      item_label: resolved.label, unit: resolved.unit, quantity: parsed.quantity });
    for (const [id, amount] of resolved.deltas) deltas.set(id, round6((deltas.get(id) || 0) + amount));
  }
  const first = validateInput(items[0]);
  // Existing header fields remain compatible with historic records; source_items
  // is the authoritative selection for multi-item and standalone recipe records.
  if (first.mode === 'recipe') { first.mode = 'ingredient'; first.id = deltas.keys().next().value; }
  return { parsed: first, items, deltas, label: items.map((i) => `${i.item_label} (${i.quantity} ${i.unit || ''})`).join('; '), unit: items.length === 1 ? items[0].unit : 'items', quantity: items.length === 1 ? first.quantity : items.length };
}

export async function previewKitchenUse(db, input) {
  await ensureKitchenUseSchema(db);
  const resolved = await resolveItems(db, input);
  const { parsed } = resolved;
  const components = await priceComponents(db, resolved.deltas);
  const estimated = round2(components.reduce((sum, c) => sum + c.total_cost, 0));
  const threshold = await kitchenUseThreshold(db);
  return {
    consumption_type: parsed.type,
    type_label: KITCHEN_USE_TYPES[parsed.type].label,
    item_label: resolved.label,
    items: resolved.items,
    quantity: resolved.quantity,
    unit: resolved.unit,
    components,
    estimated_cost: estimated,
    approval_threshold: threshold,
    approval_required: needsApproval(parsed.type, estimated, threshold),
    short_items: components.filter((c) => c.short).map((c) => c.item_name),
  };
}

async function businessDate(db, businessDayId) {
  const row = businessDayId ? await db.get('SELECT business_date FROM business_days WHERE id = ?', [businessDayId]) : null;
  return row?.business_date ? String(row.business_date).slice(0, 10) : undefined;
}

/** The single posting event: stock out + cost snapshot + journal, on a tx-scoped db. */
async function postRecord(tx, record, actorId) {
  const businessDayId = await currentBusinessDayId(tx, { required: true });
  const resolved = record.source_items ? await resolveItems(tx, { consumption_type: record.consumption_type, items: JSON.parse(record.source_items) }) : await resolveConsumption(tx, {
    mode: record.source_mode,
    id: record.source_mode === 'dish' ? record.menu_item_id : record.inventory_item_id,
    quantity: Number(record.quantity),
    unit: record.source_mode === 'ingredient' ? record.unit : null,
  });
  const reason = `${record.reference_number} · ${KITCHEN_USE_TYPES[record.consumption_type].label}`;
  let total = 0;
  for (const [inventoryItemId, quantity] of resolved.deltas) {
    const moved = await applyStockChange(tx, {
      inventory_item_id: inventoryItemId,
      quantity: -quantity,
      change_type: 'kitchen_use',
      performed_by: actorId,
      reason,
      reference_id: record.id,
      business_day_id: businessDayId,
    });
    if (!moved) fail('A recipe ingredient is missing from inventory.', 409);
    // The ledger floors stock at zero and records the gap; kitchen use refuses
    // instead, so nobody can "eat" stock the shop does not have.
    if (Math.abs(moved.shortfall) > 1e-9) {
      fail(`Not enough ${moved.item_name} in stock: ${round6(moved.from)} available, ${round6(quantity)} needed.`, 409, { code: 'kitchen_use_insufficient_stock' });
    }
    const unit = (await tx.get('SELECT COALESCE(consumption_unit, unit) AS unit FROM inventory_items WHERE id = ?', [inventoryItemId]))?.unit || null;
    const lineCost = round2(moved.cost_value);
    total += lineCost;
    await tx.run(
      `INSERT INTO kitchen_use_components (kitchen_use_id, inventory_item_id, item_name, quantity, unit, unit_cost, total_cost, movement_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.id, inventoryItemId, moved.item_name, round6(quantity), unit, moved.unit_cost, lineCost, moved.movement_id]
    );
  }
  total = round2(total);
  const journalId = total > 0 ? await postJournal(tx, {
    entry_date: await businessDate(tx, businessDayId),
    memo: `Kitchen use ${record.reference_number} — ${KITCHEN_USE_TYPES[record.consumption_type].label}: ${record.item_label}`,
    source_type: 'kitchen_use',
    source_id: record.id,
    created_by: actorId,
    business_day_id: businessDayId,
    lines: [
      { code: KITCHEN_USE_TYPES[record.consumption_type].account, debit: total, credit: 0, memo: record.reason },
      { code: KITCHEN_USE_CONTRA_ACCOUNT, debit: 0, credit: total, memo: record.item_label },
    ],
  }) : null;
  await tx.run(
    `UPDATE kitchen_use_records
        SET status = 'posted', posted_cost = ?, journal_id = ?, business_day_id = ?, posted_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
    [total, journalId, businessDayId, record.id]
  );
}

/**
 * Record a kitchen use. Posts at once unless it needs approval and the actor
 * cannot approve. `client_key` makes a double-click or retry a no-op.
 */
export async function createKitchenUse(db, input, { actorId, canApprove }) {
  await ensureKitchenUseSchema(db);
  const reason = String(input?.reason || '').trim();
  if (!reason) fail('Say why — the reason is kept with the record.');
  const clientKey = input?.client_key ? String(input.client_key).slice(0, 100) : null;

  const write = () => db.transaction(async (tx) => {
    if (clientKey) {
      const existing = await tx.get('SELECT id FROM kitchen_use_records WHERE client_key = ?', [clientKey]);
      if (existing) return existing.id;
    }
    const businessDayId = await currentBusinessDayId(tx, { required: true });
    const resolved = await resolveItems(tx, input);
    const { parsed } = resolved;
    const components = await priceComponents(tx, resolved.deltas);
    const estimated = round2(components.reduce((sum, c) => sum + c.total_cost, 0));
    const pending = needsApproval(parsed.type, estimated, await kitchenUseThreshold(tx)) && !canApprove;
    const reference = await nextDocumentNumber(tx, { type: 'kitchen_use', prefix: 'KU' });
    const inserted = await tx.run(
      `INSERT INTO kitchen_use_records
         (reference_number, client_key, consumption_type, source_mode, menu_item_id, inventory_item_id, item_label,
          quantity, unit, status, reason, notes, estimated_cost, business_day_id, recorded_by, approved_by, approved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?, ?, ?, ?, ?, ?, ${pending ? 'NULL' : 'CURRENT_TIMESTAMP'})`,
      [reference, clientKey, parsed.type, parsed.mode, parsed.mode === 'dish' ? parsed.id : null, parsed.mode === 'ingredient' ? parsed.id : null,
        resolved.items.length === 1 ? resolved.items[0].item_label : resolved.label, resolved.quantity, resolved.unit, reason, input?.notes ? String(input.notes).trim() : null, estimated,
        businessDayId, actorId, pending ? null : actorId]
    );
    await tx.run('UPDATE kitchen_use_records SET source_items = ? WHERE id = ?', [JSON.stringify(resolved.items), inserted.lastInsertRowid]);
    const record = await tx.get('SELECT * FROM kitchen_use_records WHERE id = ?', [inserted.lastInsertRowid]);
    if (!pending) await postRecord(tx, record, actorId);
    return record.id;
  });
  let id;
  try {
    id = await write();
  } catch (error) {
    // A concurrent retry with the same key lost the UNIQUE race: return the winner.
    const winner = clientKey ? await db.get('SELECT id FROM kitchen_use_records WHERE client_key = ?', [clientKey]).catch(() => null) : null;
    if (!winner) throw error;
    id = winner.id;
  }
  return getKitchenUse(db, id);
}

export async function decideKitchenUse(db, id, { approve, actorId, note = '' }) {
  await ensureKitchenUseSchema(db);
  await db.transaction(async (tx) => {
    const record = await tx.get(`SELECT * FROM kitchen_use_records WHERE id = ?${tx.driver === 'postgres' ? ' FOR UPDATE' : ''}`, [id]);
    if (!record) fail('Kitchen use record not found.', 404);
    if (record.status !== 'pending_approval') fail('Only records waiting for approval can be approved or rejected.', 409);
    if (!approve && !String(note).trim()) fail('Give a reason for rejecting.');
    await tx.run(
      `UPDATE kitchen_use_records SET status = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP, decided_note = ? WHERE id = ? AND status = 'pending_approval'`,
      [approve ? 'pending_approval' : 'rejected', actorId, String(note).trim() || null, id]
    );
    // Approval IS the posting event: stock and cost are re-checked right now.
    if (approve) await postRecord(tx, record, actorId);
  });
  return getKitchenUse(db, id);
}

/** Undo a posted record: stock back at its original cost, mirror journal, history kept. */
export async function reverseKitchenUse(db, id, { actorId, reason }) {
  await ensureKitchenUseSchema(db);
  if (!String(reason || '').trim()) fail('Give a reason for the reversal.');
  await db.transaction(async (tx) => {
    const record = await tx.get(`SELECT * FROM kitchen_use_records WHERE id = ?${tx.driver === 'postgres' ? ' FOR UPDATE' : ''}`, [id]);
    if (!record) fail('Kitchen use record not found.', 404);
    if (record.status !== 'posted') fail(record.status === 'reversed' ? 'This record was already reversed.' : 'Only posted records can be reversed.', 409);
    const businessDayId = await currentBusinessDayId(tx, { required: true });
    const components = await tx.all('SELECT * FROM kitchen_use_components WHERE kitchen_use_id = ?', [id]);
    for (const component of components) {
      // Inbound at the original basis keeps the moving average where it was.
      const moved = await applyStockChange(tx, {
        inventory_item_id: component.inventory_item_id,
        quantity: Number(component.quantity),
        change_type: 'kitchen_use_reversal',
        unit_cost: Number(component.unit_cost),
        performed_by: actorId,
        reason: `Reversal of ${record.reference_number} — ${String(reason).trim()}`,
        reference_id: record.id,
        business_day_id: businessDayId,
      });
      await tx.run('UPDATE kitchen_use_components SET reversal_movement_id = ? WHERE id = ?', [moved?.movement_id || null, component.id]);
    }
    const reversalJournalId = record.journal_id
      ? await reverseJournal(tx, { journal_id: record.journal_id, reason: `${record.reference_number}: ${String(reason).trim()}`, created_by: actorId, business_day_id: businessDayId })
      : null;
    const updated = await tx.run(
      `UPDATE kitchen_use_records SET status = 'reversed', reversed_by = ?, reversed_at = CURRENT_TIMESTAMP, reversal_reason = ?, reversal_journal_id = ?
        WHERE id = ? AND status = 'posted'`,
      [actorId, String(reason).trim(), reversalJournalId, id]
    );
    if (!updated?.changes) fail('This record was already reversed.', 409);
  });
  return getKitchenUse(db, id);
}

const RECORD_COLUMNS = `k.*, bd.business_date, ru.full_name AS recorded_by_name, au.full_name AS approved_by_name, vu.full_name AS reversed_by_name`;
const RECORD_FROM = `kitchen_use_records k
  LEFT JOIN business_days bd ON bd.id = k.business_day_id
  LEFT JOIN users ru ON ru.id = k.recorded_by
  LEFT JOIN users au ON au.id = k.approved_by
  LEFT JOIN users vu ON vu.id = k.reversed_by`;

export async function getKitchenUse(db, id) {
  const record = await db.get(`SELECT ${RECORD_COLUMNS} FROM ${RECORD_FROM} WHERE k.id = ?`, [id]);
  if (!record) return null;
  const components = await db.all('SELECT * FROM kitchen_use_components WHERE kitchen_use_id = ? ORDER BY id', [id]);
  return { ...record, items: record.source_items ? JSON.parse(record.source_items) : [], type_label: KITCHEN_USE_TYPES[record.consumption_type]?.label || record.consumption_type, components };
}

export async function listKitchenUse(db, { from, to, type, status, search, ...list } = {}) {
  await ensureKitchenUseSchema(db);
  const where = ['1=1'];
  const params = [];
  // Both sides must be the same type on Postgres (DATE there, TEXT on SQLite).
  const day = "COALESCE(bd.business_date, date(k.created_at, '+5 hours', '+45 minutes'))";
  if (from) { where.push(`${day} >= ?`); params.push(from); }
  if (to) { where.push(`${day} <= ?`); params.push(to); }
  if (type && KITCHEN_USE_TYPES[type]) { where.push('k.consumption_type = ?'); params.push(type); }
  if (status && STATUSES.includes(status)) { where.push('k.status = ?'); params.push(status); }
  if (search) {
    const like = `%${String(search).toLowerCase()}%`;
    where.push("(LOWER(k.item_label) LIKE ? OR LOWER(k.reference_number) LIKE ? OR LOWER(COALESCE(k.reason,'')) LIKE ? OR LOWER(COALESCE(ru.full_name,'')) LIKE ?)");
    params.push(like, like, like, like);
  }
  const result = await paginateQuery(db, {
    columns: `${RECORD_COLUMNS}, ${day} AS use_date`,
    from: RECORD_FROM,
    where: where.join(' AND '),
    params,
    orderBy: 'k.created_at DESC, k.id DESC',
    ...list,
  });
  const totals = await db.all(
    `SELECT k.consumption_type, k.status, COUNT(*) AS n, COALESCE(SUM(COALESCE(k.posted_cost, k.estimated_cost)), 0) AS cost
       FROM ${RECORD_FROM} WHERE ${where.join(' AND ')} GROUP BY k.consumption_type, k.status`,
    params
  );
  const summary = { posted_cost: 0, posted_count: 0, pending_count: 0, by_type: {} };
  for (const row of totals || []) {
    if (row.status === 'pending_approval') summary.pending_count += Number(row.n);
    if (row.status !== 'posted') continue;
    summary.posted_cost = round2(summary.posted_cost + Number(row.cost));
    summary.posted_count += Number(row.n);
    summary.by_type[row.consumption_type] = round2(Number(row.cost));
  }
  return {
    ...result,
    rows: result.rows.map((row) => ({ ...row, type_label: KITCHEN_USE_TYPES[row.consumption_type]?.label || row.consumption_type })),
    summary,
  };
}

/** Kitchen use cost per type from the ledger (posted minus reversed), for reports. */
export async function kitchenUseCostByType(db, start, end) {
  await ensureAccountingSchema(db);
  const codes = Object.values(KITCHEN_USE_TYPES).map((t) => `'${t.account}'`).join(',');
  const rows = await db.all(
    `SELECT a.code, COALESCE(SUM(jl.debit - jl.credit), 0) AS amount
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.journal_id
       LEFT JOIN journal_entries original ON je.source_type = 'reversal' AND original.id = je.source_id
       JOIN accounts a ON a.id = jl.account_id
      WHERE (je.source_type = 'kitchen_use' OR original.source_type = 'kitchen_use')
        AND a.code IN (${codes}) AND je.entry_date BETWEEN ? AND ?
      GROUP BY a.code`,
    [start, end]
  ).catch(() => []);
  const byCode = new Map((rows || []).map((row) => [row.code, round2(row.amount)]));
  const out = Object.fromEntries(Object.entries(KITCHEN_USE_TYPES).map(([key, t]) => [key, byCode.get(t.account) || 0]));
  out.business_total = round2(out.chef_tasting + out.recipe_testing + out.staff_meal + out.guest_sample);
  out.total = round2(out.business_total + out.owner_use);
  return out;
}

const COST_KEYS = ['estimated_cost', 'posted_cost', 'unit_cost', 'total_cost', 'cost_value'];

export function kitchenUseAccess(role) {
  return {
    canCreate: isPermissionAllowedSync(role, 'kitchen_use.create'),
    canApprove: isPermissionAllowedSync(role, 'kitchen_use.approve'),
    canReverse: isPermissionAllowedSync(role, 'kitchen_use.reverse'),
    canViewCost: isPermissionAllowedSync(role, 'kitchen_use.view_cost'),
    canManageSettings: role === 'admin',
  };
}

/** Cost visibility is its own permission, so strip money server-side. */
export function hideCosts(value) {
  if (Array.isArray(value)) return value.map(hideCosts);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !COST_KEYS.includes(key) && key !== 'summary_cost')
    .map(([key, v]) => [key, key === 'summary' ? { ...v, posted_cost: null, by_type: {} } : hideCosts(v)]));
}

