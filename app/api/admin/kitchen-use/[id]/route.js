import { NextResponse } from 'next/server';
import Database from '@/lib/db/index';
import { requireAuth, handleRouteError } from '@/lib/api-guard.js';
import { decideKitchenUse, ensureKitchenUseSchema, getKitchenUse, hideCosts, kitchenUseAccess, reverseKitchenUse } from '@/lib/kitchen-use.js';

const ROLES = ['admin', 'cashier', 'kitchen', 'waiter'];

function recordId(params) {
  const id = Number(params?.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function GET(request, { params }) {
  try {
    const auth = await requireAuth(request, { roles: ROLES, permission: 'kitchen_use.view' });
    if (auth.error) return auth.error;
    const id = recordId(await params);
    if (!id) return NextResponse.json({ error: 'Invalid record.' }, { status: 400 });
    const db = Database.getInstance();
    await ensureKitchenUseSchema(db);
    const record = await getKitchenUse(db, id);
    if (!record) return NextResponse.json({ error: 'Kitchen use record not found.' }, { status: 404 });
    const access = kitchenUseAccess(auth.user.role);
    return NextResponse.json(access.canViewCost ? record : hideCosts(record), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return handleRouteError(error, 'Could not load kitchen use.');
  }
}

/** POST { action: 'approve' | 'reject' | 'reverse', note } — each checked against its own permission. */
export async function POST(request, { params }) {
  try {
    const body = await request.json().catch(() => ({}));
    const permission = body.action === 'reverse' ? 'kitchen_use.reverse' : 'kitchen_use.approve';
    if (!['approve', 'reject', 'reverse'].includes(body.action)) {
      return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });
    }
    const auth = await requireAuth(request, { roles: ROLES, permission });
    if (auth.error) return auth.error;
    const id = recordId(await params);
    if (!id) return NextResponse.json({ error: 'Invalid record.' }, { status: 400 });
    const db = Database.getInstance();
    const note = String(body.note || '').slice(0, 500);
    const record = body.action === 'reverse'
      ? await reverseKitchenUse(db, id, { actorId: auth.user.id, reason: note })
      : await decideKitchenUse(db, id, { approve: body.action === 'approve', actorId: auth.user.id, note });
    const access = kitchenUseAccess(auth.user.role);
    return NextResponse.json(access.canViewCost ? record : hideCosts(record));
  } catch (error) {
    return handleRouteError(error, 'Could not update kitchen use.');
  }
}
