/**
 * Ingredient usage: opening stock, what came in, what sold dishes used, and
 * what is left — per raw material, for one reporting period.
 *
 * Everything is read from stock_movements, the ledger every stock change
 * already writes (in the item's stock unit). Closing stock is the live
 * quantity minus whatever moved after the period, and opening stock is
 * closing minus the period's net change, so each row always adds up.
 */

import { countedBillSql } from '@/lib/report-scope.js';
import { explodeRecipe } from '@/lib/recipes.js';
import { purchaseInvoiceDateSql } from '@/lib/report-dates.js';

const DAY = "date(m.created_at, '+5 hours', '+45 minutes')";
const PURCHASE_TYPES = "('purchase_receipt','manual_restock')";
const COUNT_TYPES = "('stock_count','manual_adjustment','adjustment','correction')";
const KITCHEN_TYPES = "('kitchen_use','kitchen_use_reversal')";

const round = (value) => Math.round((Number(value) || 0) * 10000) / 10000;

/** Per-ingredient sums for the period, plus what moved after it. */
function movementSums(range) {
  const inPeriod = `${DAY} BETWEEN ? AND ?`;
  const bucket = (condition) => `COALESCE(SUM(CASE WHEN ${inPeriod} AND ${condition} THEN m.quantity_changed END), 0)`;
  return {
    sql: `${bucket(`m.change_type IN ${PURCHASE_TYPES} AND m.quantity_changed > 0`)} AS received,
          ${bucket(`m.change_type IN ${PURCHASE_TYPES} AND m.quantity_changed < 0`)} AS reversals,
          ${bucket("m.change_type = 'order_deduction'")} AS deducted,
          ${bucket("m.change_type = 'order_void'")} AS restored,
          ${bucket("m.change_type = 'wastage'")} AS wastage,
          ${bucket(`m.change_type IN ${KITCHEN_TYPES}`)} AS kitchen_use,
          ${bucket(`m.change_type NOT IN ${PURCHASE_TYPES} AND m.change_type NOT IN ${KITCHEN_TYPES} AND m.change_type NOT IN ('order_deduction','order_void','wastage')`)} AS other,
          COALESCE(SUM(CASE WHEN ${DAY} > ? THEN m.quantity_changed END), 0) AS after_period`,
    params: [
      ...Array(7).fill([range.start, range.end]).flat(),
      range.end,
    ],
  };
}

/** Turn raw signed sums into the plain numbers the report shows. */
function balance(row) {
  const received = round(row.received);
  const reversals = round(-row.reversals);
  const deducted = round(-row.deducted);
  const restored = round(row.restored);
  const wastage = round(-row.wastage);
  const kitchenUse = round(-row.kitchen_use);
  const other = round(row.other);
  const closing = round(Number(row.quantity) - Number(row.after_period));
  const opening = round(closing - (received - reversals - deducted + restored - wastage - kitchenUse + other));
  return {
    opening, received, reversals, deducted, restored, wastage, kitchen_use: kitchenUse, other, closing,
    net_received: round(received - reversals),
    used: round(deducted - restored),
  };
}

function usageBasis(used, inRecipe) {
  if (used > 0) return 'Sold dishes (recipe)';
  if (used < 0) return 'Restored from voided orders';
  return inRecipe ? 'No sales' : 'Not in any recipe';
}

/** One row per active ingredient. Filters: search (name/category), purchaseCategory (inventory category id). */
export async function ingredientUsageRows(db, range, f = {}) {
  const sums = movementSums(range);
  const where = ['COALESCE(i.is_archived, 0) = 0'];
  const params = [...sums.params];
  if (f.search) {
    const like = `%${String(f.search).toLowerCase()}%`;
    where.push("(LOWER(COALESCE(i.item_name, i.name, '')) LIKE ? OR LOWER(COALESCE(i.category, '')) LIKE ?)");
    params.push(like, like);
  }
  if (f.purchaseCategory) {
    where.push('i.category_id = ?');
    params.push(f.purchaseCategory);
  }
  const rows = await db.all(
    `SELECT i.id, COALESCE(i.item_name, i.name) AS item_name, COALESCE(i.consumption_unit, i.unit) AS unit,
            i.category, i.quantity, i.cost_per_unit,
            EXISTS (SELECT 1 FROM recipe_items ri WHERE ri.raw_material_id = i.id) AS in_recipe,
            ${sums.sql}
       FROM inventory_items i
       LEFT JOIN stock_movements m ON m.inventory_item_id = i.id
      WHERE ${where.join(' AND ')}
      GROUP BY i.id, i.item_name, i.name, i.consumption_unit, i.unit, i.category, i.quantity, i.cost_per_unit
      ORDER BY LOWER(COALESCE(i.item_name, i.name)) ASC`,
    params
  );
  return (rows || []).map((row) => {
    const b = balance(row);
    return {
      _record_id: row.id,
      item_name: row.item_name || `Ingredient #${row.id}`,
      category: row.category || 'Uncategorised',
      unit: row.unit || '',
      opening: b.opening,
      received: b.net_received,
      used: b.used,
      wastage: b.wastage,
      kitchen_use: b.kitchen_use,
      other: b.other,
      closing: b.closing,
      closing_value: round(b.closing * (Number(row.cost_per_unit) || 0)),
      usage_basis: usageBasis(b.used, Number(row.in_recipe) === 1),
    };
  });
}

/** Everything the ingredient drawer shows, for one ingredient and period. */
export async function ingredientDetail(db, id, range) {
  const item = await db.get(
    `SELECT id, COALESCE(item_name, name) AS item_name, COALESCE(consumption_unit, unit) AS unit,
            purchase_unit, conversion_factor, category, quantity, cost_per_unit, min_stock_level
       FROM inventory_items WHERE id = ?`,
    [id]
  );
  if (!item) return null;
  const sums = movementSums(range);
  const sumRow = await db.get(
    `SELECT ${sums.sql} FROM stock_movements m WHERE m.inventory_item_id = ?`,
    [...sums.params, id]
  );
  const summary = balance({ ...(sumRow || {}), quantity: item.quantity });

  const [purchases, wastage, movements, counts, recipes] = await Promise.all([
    db.all(
      `SELECT p.id AS purchase_id, p.invoice_number, ${purchaseInvoiceDateSql('p')} AS invoice_date,
              COALESCE(s.name, p.supplier, 'Unattributed') AS supplier, p.status,
              pi.quantity_received, pi.unit_cost, pi.line_total
         FROM purchase_items pi
         JOIN purchases p ON p.id = pi.purchase_id
         LEFT JOIN suppliers s ON s.id = p.supplier_id
        WHERE pi.inventory_item_id = ?
          AND ${purchaseInvoiceDateSql('p')} BETWEEN ? AND ?
        ORDER BY invoice_date DESC, p.id DESC`,
      [id, range.start, range.end]
    ).catch(() => []),
    db.all(
      `SELECT w.id, w.created_at, w.quantity, w.unit, w.reason, w.notes, w.total_cost, w.status, u.full_name AS logged_by_name
         FROM wastage_log w
         LEFT JOIN users u ON u.id = COALESCE(w.employee_id, w.logged_by)
        WHERE w.raw_material_id = ? AND date(w.created_at, '+5 hours', '+45 minutes') BETWEEN ? AND ?
        ORDER BY w.created_at DESC`,
      [id, range.start, range.end]
    ).catch(() => []),
    db.all(
      `SELECT m.id, m.created_at, m.change_type, m.quantity_changed, m.balance_after, m.reason, m.reference_id,
              u.full_name AS performed_by_name
         FROM stock_movements m
         LEFT JOIN users u ON u.id = m.performed_by
        WHERE m.inventory_item_id = ? AND ${DAY} BETWEEN ? AND ?
        ORDER BY m.created_at DESC, m.id DESC`,
      [id, range.start, range.end]
    ),
    db.all(
      `SELECT m.id, m.created_at, m.change_type, m.quantity_changed, m.balance_after, m.variance, m.reason
         FROM stock_movements m
        WHERE m.inventory_item_id = ? AND m.change_type IN ${COUNT_TYPES} AND ${DAY} BETWEEN ? AND ?
        ORDER BY m.created_at DESC, m.id DESC`,
      [id, range.start, range.end]
    ),
    db.all(
      `SELECT r.id, r.menu_item_id, r.yield_quantity, mi.name AS dish_name
         FROM recipes r JOIN menu_items mi ON mi.id = r.menu_item_id
        WHERE COALESCE(r.is_active, 1) = 1`
    ).catch(() => []),
  ]);

  // Dishes that use this ingredient, directly or through a sub-recipe.
  const dishes = [];
  for (const recipe of recipes || []) {
    let perPortion = 0;
    try {
      const yieldQty = Number(recipe.yield_quantity) > 0 ? Number(recipe.yield_quantity) : 1;
      perPortion = (await explodeRecipe(db, recipe.id, 1 / yieldQty)).get(Number(id)) || 0;
    } catch {
      continue; // a broken recipe should not hide the rest of the report
    }
    if (perPortion > 0) dishes.push({ menu_item_id: recipe.menu_item_id, dish_name: recipe.dish_name, per_portion: round(perPortion) });
  }
  if (dishes.length) {
    const sold = await db.all(
      `SELECT COALESCE(oi.menu_item_id, oi.item_id) AS menu_item_id, SUM(oi.quantity) AS portions,
              SUM(COALESCE(oi.subtotal, oi.quantity * oi.price)) AS sales
         FROM bills b JOIN orders o ON o.id = b.order_id JOIN order_items oi ON oi.order_id = o.id
        WHERE ${countedBillSql('b')} AND date(b.created_at, '+5 hours', '+45 minutes') BETWEEN ? AND ?
          AND COALESCE(oi.status, '') NOT IN ('voided', 'cancelled')
          AND COALESCE(oi.menu_item_id, oi.item_id) IN (${dishes.map(() => '?').join(',')})
        GROUP BY COALESCE(oi.menu_item_id, oi.item_id)`,
      [range.start, range.end, ...dishes.map((d) => d.menu_item_id)]
    ).catch(() => []);
    const byDish = new Map((sold || []).map((row) => [Number(row.menu_item_id), row]));
    for (const dish of dishes) {
      const row = byDish.get(Number(dish.menu_item_id));
      dish.portions_sold = round(row?.portions);
      dish.sales = round(row?.sales);
      dish.expected_use = round(dish.portions_sold * dish.per_portion);
      dish.possible_portions = dish.per_portion > 0 ? Math.max(0, Math.floor(Number(item.quantity) / dish.per_portion)) : 0;
    }
    dishes.sort((a, b) => b.portions_sold - a.portions_sold || a.dish_name.localeCompare(b.dish_name));
  }

  const receivedValue = (purchases || [])
    .filter((p) => p.status !== 'voided')
    .reduce((sum, p) => sum + (Number(p.line_total) || 0), 0);

  return {
    item: { ...item, quantity: round(item.quantity) },
    range,
    summary: {
      ...summary,
      received_value: round(receivedValue),
      portions_sold: round(dishes.reduce((sum, d) => sum + d.portions_sold, 0)),
      usage_basis: usageBasis(summary.used, dishes.length > 0),
    },
    dishes,
    purchases: purchases || [],
    wastage: wastage || [],
    movements: movements || [],
    counts: counts || [],
  };
}
