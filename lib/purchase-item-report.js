/** Names and quantities for each invoice, fetched in batches for large exports. */
export async function purchaseItemSummaries(db, purchases) {
  const summaries = new Map();
  for (let offset = 0; offset < purchases.length; offset += 400) {
    const ids = purchases.slice(offset, offset + 400).map((p) => p.id);
    const rows = await db.all(`SELECT pi.purchase_id, pi.quantity_received, COALESCE(i.purchase_unit, i.unit) AS unit, pi.unit_cost,
      COALESCE(i.item_name, i.name, 'Unknown item') AS item_name
      FROM purchase_items pi LEFT JOIN inventory_items i ON i.id = pi.inventory_item_id
      WHERE pi.purchase_id IN (${ids.map(() => '?').join(',')}) ORDER BY pi.purchase_id, pi.id`, ids);
    for (const row of rows) {
      const id = Number(row.purchase_id);
      const parts = summaries.get(id) || [];
      parts.push(`${row.item_name} — ${Number(row.quantity_received || 0)} ${row.unit || ''} @ Rs ${Number(row.unit_cost || 0).toFixed(2)}`.trim());
      summaries.set(id, parts);
    }
  }
  return new Map([...summaries].map(([id, parts]) => [id, parts.join('; ')]));
}
