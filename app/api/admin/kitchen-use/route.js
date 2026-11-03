import { NextResponse } from 'next/server';
import Database from '@/lib/db/index';
import { requireAuth, handleRouteError } from '@/lib/api-guard.js';
import { readListParams } from '@/lib/paginate.js';
import {
  KITCHEN_USE_TYPES, createKitchenUse, ensureKitchenUseSchema, hideCosts, kitchenUseAccess, kitchenUseThreshold,
  listKitchenUse, previewKitchenUse, setKitchenUseThreshold,
} from '@/lib/kitchen-use.js';

const ROLES = ['admin', 'cashier', 'kitchen', 'waiter'];
export async function GET(request) {
  try {
    const auth = await requireAuth(request, { roles: ROLES, permission: 'kitchen_use.view' });
    if (auth.error) return auth.error;
    const q = new URL(request.url).searchParams;
    const db = Database.getInstance();
    await ensureKitchenUseSchema(db);
    const access = kitchenUseAccess(auth.user.role);
    const result = await listKitchenUse(db, {
      ...readListParams(q),
      from: q.get('from') || null,
      to: q.get('to') || null,
      type: q.get('type') || null,
      status: q.get('status') || null,
      search: (q.get('search') || '').trim().slice(0, 100),
    });
    let options = null;
    if (q.get('options') === '1') {
      const [dishes, ingredients, recipes] = await Promise.all([
        db.all(`SELECT mi.id, mi.name FROM menu_items mi
                 WHERE EXISTS (SELECT 1 FROM recipes r WHERE r.menu_item_id = mi.id AND COALESCE(r.is_active, 1) = 1)
                    OR EXISTS (SELECT 1 FROM inventory_items i WHERE i.menu_item_id = mi.id AND COALESCE(i.is_archived, 0) = 0)
                 ORDER BY mi.name`),
        db.all(`SELECT id, COALESCE(item_name, name) AS name, COALESCE(consumption_unit, unit) AS unit, purchase_unit, quantity, cost_per_unit AS unit_cost, conversion_factor
                  FROM inventory_items WHERE COALESCE(is_archived, 0) = 0 ORDER BY LOWER(COALESCE(item_name, name))`),
        db.all(`SELECT id, name, yield_quantity, yield_unit FROM recipes WHERE COALESCE(is_active, 1) = 1 ORDER BY name`),
      ]);
      options = { dishes, ingredients, recipes, threshold: await kitchenUseThreshold(db) };
    }
    const body = {
      ...result,
      types: Object.entries(KITCHEN_USE_TYPES).map(([id, t]) => ({ id, label: t.label })),
      access,
      ...(options ? { options } : {}),
    };
    return NextResponse.json(access.canViewCost ? body : hideCosts(body), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return handleRouteError(error, 'Could not load kitchen use.');
  }
}

/** POST { action: 'preview' | 'create' | 'settings', ... } */
export async function POST(request) {
  try {
    const auth = await requireAuth(request, { roles: ROLES, permission: 'kitchen_use.create' });
    if (auth.error) return auth.error;
    const body = await request.json().catch(() => ({}));
    const db = Database.getInstance();
    const access = kitchenUseAccess(auth.user.role);
    const reply = (data, status = 200) => NextResponse.json(access.canViewCost ? data : hideCosts(data), { status });

    if (body.action === 'preview') return reply(await previewKitchenUse(db, body));
    if (body.action === 'settings') {
      if (!access.canManageSettings) return NextResponse.json({ error: 'Only an admin can change the approval limit.' }, { status: 403 });
      await ensureKitchenUseSchema(db);
      return reply({ threshold: await setKitchenUseThreshold(db, body.threshold) });
    }
    // Who recorded it comes from the session, never from the request body.
    const record = await createKitchenUse(db, body, { actorId: auth.user.id, canApprove: access.canApprove });
    return reply(record, 201);
  } catch (error) {
    return handleRouteError(error, 'Could not record kitchen use.');
  }
}
