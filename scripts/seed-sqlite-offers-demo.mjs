/**
 * Local SQLite demo offers and combo packs, created through the real admin
 * APIs (same validation as the admin screens). Shows on the home page "Offers
 * & combos" strip, /offers, the menu badges and the website cart discount.
 *
 * Run once; a second run is a no-op.
 *   npm run db:seed-sqlite-offers
 */
if (process.env.DATABASE_URL || process.env.NODE_ENV === 'production') throw new Error('Demo seeding is allowed only in local SQLite development.');
const Database = (await import('../lib/db/index.js')).default;
const db = Database.getInstance();
const { POST: createPromotion } = await import('../app/api/admin/promotions/route.js');
const { POST: createCombo } = await import('../app/api/admin/combos/route.js');

if (await db.get("SELECT id FROM promotions WHERE code = 'MOMO100'").catch(() => null)) {
  console.log('Demo offers already seeded.');
  process.exit(0);
}

const admin = await db.get("SELECT id FROM users WHERE role = 'admin' AND is_active = 1 LIMIT 1");
const token = `offers-seed-${crypto.randomUUID()}`;
await db.run("INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, datetime('now', '+1 hour'))", [admin.id, token]);
const item = async (name) => (await db.get('SELECT id, category_id FROM menu_items WHERE name = ? AND is_available = 1', [name]))
  || (() => { throw new Error(`Menu item "${name}" not found.`); })();
const category = async (name) => (await db.get('SELECT id FROM menu_categories WHERE name = ?', [name]))?.id;
const post = async (handler, url, body) => {
  const res = await handler(new Request(`http://localhost${url}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  const data = await res.json();
  if (!res.ok) throw new Error(`${body.name}: ${data.error}`);
  console.log(`+ ${body.name}`);
  return data.id;
};
const nextMonth = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
const all = ['pos', 'website', 'qr'];

try {
  await post(createPromotion, '/api/admin/promotions', {
    name: 'Lunch happy hour', description: 'Long lunch? Take 15% off the whole bill.',
    discount_type: 'percent', discount_value: 15, scope: 'order', minimum_order_amount: 800, maximum_discount_amount: 300,
    daily_start_time: '11:00', daily_end_time: '15:00', channels: all, auto_apply: true,
  });
  await post(createPromotion, '/api/admin/promotions', {
    name: 'Momo deal', description: 'Rs 100 off any momo plate with the code.', code: 'MOMO100',
    discount_type: 'fixed', discount_value: 100, scope: 'item', minimum_order_amount: 300,
    target_ids: [(await item('Veg Momos (8pcs)')).id, (await item('Chicken Momos (8pcs)')).id],
    ends_at: `${nextMonth}T22:00`, channels: all,
  });
  await post(createPromotion, '/api/admin/promotions', {
    name: 'Lassi trio', description: 'Buy two lassis, the third is on us.',
    offer_type: 'buy_x_get_y', buy_quantity: 2, reward_quantity: 1, reward_discount_percent: 100,
    scope: 'item', target_ids: [(await item('Sweet Lassi')).id], channels: all, auto_apply: true,
  });
  await post(createPromotion, '/api/admin/promotions', {
    name: 'Dessert hour', description: '20% off every dessert in the evening.',
    discount_type: 'percent', discount_value: 20, scope: 'category', target_ids: [await category('Desserts')],
    daily_start_time: '17:00', daily_end_time: '21:00', channels: all, auto_apply: true,
  });
  await post(createPromotion, '/api/admin/promotions', {
    name: 'Weekend family', description: 'Saturday and Sunday only.',
    discount_type: 'percent', discount_value: 10, scope: 'order', minimum_order_amount: 1500,
    days_of_week: ['sat', 'sun'], channels: all, auto_apply: true,
  });
  await post(createPromotion, '/api/admin/promotions', {
    name: 'Counter-only tea deal', description: 'POS only — must not appear on the website.',
    discount_type: 'fixed', discount_value: 10, scope: 'item', target_ids: [(await item('Masala Tea')).id], channels: ['pos'], auto_apply: true,
  });

  const momo = await item('Chicken Momos (8pcs)');
  await post(createCombo, '/api/admin/combos', {
    name: 'Momo & Coke combo', description: 'Our chicken momo plate with a chilled Coke.',
    category_id: momo.category_id, price: 250, channels: all, website_featured: true,
    components: [{ menu_item_id: momo.id, quantity: 1 }, { menu_item_id: (await item('Coke')).id, quantity: 1 }],
  });
  const thali = await item('Veg Thali');
  await post(createCombo, '/api/admin/combos', {
    name: 'Thali for two', description: 'Two veg thalis, two lassis and gulab jamun to finish.',
    category_id: thali.category_id, price: 899, channels: all,
    components: [{ menu_item_id: thali.id, quantity: 2 }, { menu_item_id: (await item('Sweet Lassi')).id, quantity: 2 }, { menu_item_id: (await item('Gulab Jamun')).id, quantity: 2 }],
  });
  await post(createCombo, '/api/admin/combos', {
    name: 'Biryani meal', description: 'Chicken biryani with raita-friendly lassi.',
    category_id: (await item('Chicken Biryani')).category_id, price: 499, channels: ['pos', 'qr'],
    components: [{ menu_item_id: (await item('Chicken Biryani')).id, quantity: 1 }, { menu_item_id: (await item('Sweet Lassi')).id, quantity: 1 }],
  });
} finally {
  await db.run('DELETE FROM sessions WHERE token = ?', [token]);
  await Database.close();
}
console.log('Done. The website shows what is scheduled for right now (Nepal time).');
