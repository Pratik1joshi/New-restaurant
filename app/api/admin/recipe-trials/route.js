import { NextResponse } from 'next/server';
import Database from '@/lib/db/index';
import { requireAuth, handleRouteError } from '@/lib/api-guard.js';
import { hideCosts, kitchenUseAccess } from '@/lib/kitchen-use.js';
import { confirmRecipeTrial, listRecipeTrials, saveRecipeTrial, startRecipeTrial } from '@/lib/recipe-trials.js';

const roles = ['admin', 'cashier', 'kitchen', 'waiter'];
export async function GET(request) {
  try {
    const auth = await requireAuth(request, { roles, permission: 'kitchen_use.view' });
    if (auth.error) return auth.error;
    return NextResponse.json({ trials: await listRecipeTrials(Database.getInstance()) }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return handleRouteError(error, 'Could not load recipe trials.'); }
}

export async function POST(request) {
  try {
    const auth = await requireAuth(request, { roles, permission: 'kitchen_use.create' });
    if (auth.error) return auth.error;
    const input = await request.json();
    const db = Database.getInstance();
    const access = kitchenUseAccess(auth.user.role);
    if (input.action === 'save') return NextResponse.json({ trial: await saveRecipeTrial(db, input, auth.user.id) });
    if (input.action === 'start') return NextResponse.json({ trial: await startRecipeTrial(db, input.id, auth.user.id) });
    if (input.action !== 'confirm') return NextResponse.json({ error: 'Unknown trial action.' }, { status: 400 });
    const record = await confirmRecipeTrial(db, input.id, input, { actorId: auth.user.id, canApprove: access.canApprove });
    return NextResponse.json({ record: access.canViewCost ? record : hideCosts(record) });
  } catch (error) { return handleRouteError(error, 'Could not save recipe trial.'); }
}
