import { NextResponse } from 'next/server';
import Database from '@/lib/db/index';
import { requireAuth, handleRouteError } from '@/lib/api-guard.js';
import { accountBalance, ensureAccountingSchema } from '@/lib/accounting.js';
import { listBankAccounts } from '@/lib/accounting-cash.js';
import { readListParams } from '@/lib/paginate.js';
import { supplierPayables, supplierPayablesPage, supplierStatement, supplierLedgerHistoryPage, liabilityLedger, liabilityAgeing, paySupplier, supplierOpenInvoices } from '@/lib/accounting-suppliers.js';

export async function GET(request) {
  try {
    const auth = await requireAuth(request, { roles: ['admin', 'cashier'], permission: 'supplier_ledger.access' });
    if (auth.error) return auth.error;
    const db = Database.getInstance();
    await ensureAccountingSchema(db);
    const q = new URL(request.url).searchParams;

    if (q.get('view') === 'history') {
      const { page, pageSize, exportAll, search } = readListParams(q);
      const { rows, pagination, summary } = await supplierLedgerHistoryPage(db, {
        from: q.get('from'), to: q.get('to'), status: q.get('status') || 'all', search, page, pageSize, exportAll,
      });
      return NextResponse.json({ history: rows, pagination, summary });
    }

    if (q.get('view') === 'payables') {
      const { page, pageSize, exportAll, search } = readListParams(q);
      const { rows, pagination, summary } = await supplierPayablesPage(db, { search, page, pageSize, exportAll });
      return NextResponse.json({ payables: rows, pagination, summary });
    }

    const supplierId = q.get('supplier_id');
    if (supplierId) {
      const [statement, invoices] = await Promise.all([
        supplierStatement(db, supplierId, { from: q.get('from'), to: q.get('to') }),
        supplierOpenInvoices(db, supplierId),
      ]);
      return NextResponse.json({ statement, invoices });
    }
    const [payables, ageing, liabilities, banks, businessFundingAvailable] = await Promise.all([
      supplierPayables(db),
      liabilityAgeing(db),
      liabilityLedger(db),
      listBankAccounts(db),
      accountBalance(db, '1050'),
    ]);
    return NextResponse.json({ payables, ageing, liabilities, banks, business_funding_available: Math.max(0, Number(businessFundingAvailable || 0)) });
  } catch (error) {
    return handleRouteError(error, 'Failed to load accounts payable');
  }
}

export async function POST(request) {
  try {
    const auth = await requireAuth(request, { roles: ['admin', 'cashier'], permission: 'supplier_ledger.access' });
    if (auth.error) return auth.error;
    const db = Database.getInstance();
    await ensureAccountingSchema(db);
    const journal_id = await paySupplier(db, { ...(await request.json()), created_by: auth.user?.id || null });
    return NextResponse.json({ message: 'Supplier payment recorded.', journal_id }, { status: 201 });
  } catch (error) {
    return handleRouteError(error, 'Failed to record supplier payment');
  }
}
