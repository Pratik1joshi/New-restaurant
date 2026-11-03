import { NextResponse } from 'next/server';
import Database from '@/lib/db/index';
import { requireAuth, handleRouteError } from '@/lib/api-guard.js';
import { allowedReportTabs, ensureReportSchema } from '@/lib/reports.js';
import { ingredientDetail } from '@/lib/ingredient-usage.js';
import { isPermissionAllowedSync } from '@/lib/permissions.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** GET /api/admin/reports/ingredient?id=&startDate=&endDate= — the ingredient drawer. */
export async function GET(request) {
  try {
    const auth = await requireAuth(request, { roles: ['admin', 'cashier'], permission: 'reports.view' });
    if (auth.error) return auth.error;
    const allowedTabs = allowedReportTabs(auth.user?.role, (key) => isPermissionAllowedSync(auth.user?.role, key));
    if (!allowedTabs.includes('ingredients')) {
      return NextResponse.json({ error: 'This report has not been enabled for your role.' }, { status: 403 });
    }
    const q = new URL(request.url).searchParams;
    const id = Number(q.get('id'));
    const start = q.get('startDate') || '';
    const end = q.get('endDate') || '';
    if (!Number.isSafeInteger(id) || id < 1 || !DATE.test(start) || !DATE.test(end) || start > end) {
      return NextResponse.json({ error: 'Choose an ingredient and a valid period.' }, { status: 400 });
    }
    const db = Database.getInstance();
    await ensureReportSchema(db);
    const detail = await ingredientDetail(db, id, { start, end });
    if (!detail) return NextResponse.json({ error: 'Ingredient not found.' }, { status: 404 });
    return NextResponse.json(detail, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return handleRouteError(error, 'Failed to load ingredient details.');
  }
}
