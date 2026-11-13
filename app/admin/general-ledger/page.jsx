'use client';

import { useEffect, useState } from 'react';
import AdminLayout from '@/components/admin/admin-layout';
import { useToast } from '@/components/ui/toast';
import { friendlyFromError } from '@/lib/friendly-message';
import { apiJson } from '@/lib/authed-fetch';
import LedgerTable, { money } from '@/components/accounting/ledger-table';
import { formatNepalDate } from '@/lib/time-utils';
import DateInput from '@/components/ui/date-input.jsx';
import useServerList from '@/lib/use-server-list';
import ListSearch from '@/components/ui/list-search';
import PaginationControls from '@/components/ui/pagination-controls';

const DEBIT_NORMAL = new Set(['asset', 'expense']);

export default function GeneralLedgerPage() {
  const { addToast } = useToast();
  const [tab, setTab] = useState('ledger');
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [range, setRange] = useState({ from: '', to: '' });

  const onListError = (e) => addToast(friendlyFromError(e, 'load_failed'));
  const ledger = useServerList({
    url: '/api/admin/ledger',
    key: 'lines',
    filters: { view: 'ledger', account_id: accountId, from: range.from, to: range.to },
    enabled: tab === 'ledger' && Boolean(accountId),
    onError: onListError,
  });
  const journal = useServerList({
    url: '/api/admin/ledger',
    key: 'journals',
    filters: { view: 'journal', from: range.from, to: range.to },
    enabled: tab === 'journal',
    onError: onListError,
  });
  const journals = journal.rows;
  const active = tab === 'ledger' ? ledger : journal;

  useEffect(() => {
    apiJson('/api/admin/ledger?view=meta')
      .then((d) => {
        setAccounts(d.accounts || []);
        const firstWithBalance = (d.accounts || []).find((a) => Number(a.balance) !== 0) || (d.accounts || [])[1];
        if (firstWithBalance) setAccountId(String(firstWithBalance.id));
      })
      .catch((e) => addToast(friendlyFromError(e, 'load_failed')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const account = accounts.find((a) => String(a.id) === String(accountId));
  const debitNormal = account ? DEBIT_NORMAL.has(account.type) : true;
  const carried = ledger.extra.carried;
  const opening = carried ? (debitNormal ? carried.debit - carried.credit : carried.credit - carried.debit) : 0;

  return (
    <AdminLayout>
      <header className="border-b border-gray-200 bg-white px-4 py-5 sm:px-6 lg:px-8">
        <h1 className="text-2xl font-bold text-gray-900 sm:text-3xl">General Ledger</h1>
        <p className="mt-1 text-sm text-gray-500">Every posting, straight from the journals. Nothing here is a stored balance.</p>
      </header>

      <div className="space-y-5 bg-gray-50 p-4 sm:p-6 lg:p-8">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex rounded-lg border border-gray-300 bg-white p-0.5">
            {['ledger', 'journal'].map((t) => (
              <button key={t} onClick={() => setTab(t)} className={`rounded-md px-4 py-1.5 text-sm font-medium capitalize ${tab === t ? 'bg-gray-900 text-white' : 'text-gray-600'}`}>
                {t === 'ledger' ? 'By account' : 'Journal'}
              </button>
            ))}
          </div>
          {tab === 'ledger' && (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-500">Account</span>
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="h-10 rounded-lg border border-gray-300 px-3 text-sm text-gray-700">
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
              </select>
            </label>
          )}
          <label className="block"><span className="mb-1 block text-xs font-medium text-gray-500">From</span><DateInput value={range.from} onChange={(v) => setRange((r) => ({ ...r, from: v }))} className="h-10 rounded-lg border border-gray-300 px-3 text-sm" /></label>
          <label className="block"><span className="mb-1 block text-xs font-medium text-gray-500">To</span><DateInput value={range.to} onChange={(v) => setRange((r) => ({ ...r, to: v }))} className="h-10 rounded-lg border border-gray-300 px-3 text-sm" /></label>
          <div className="min-w-[240px] flex-1">
            <ListSearch key={tab} value={active.search} onSearch={active.setSearch} placeholder={tab === 'ledger' ? 'Search all postings for this account...' : 'Search all journals by number, memo or staff...'} />
          </div>
        </div>

        {tab === 'ledger' ? (
          <>
            {account && <p className="text-sm text-gray-600">Balance: <span className="font-semibold text-gray-900">{money(account.balance)}</span></p>}
            <LedgerTable lines={ledger.rows} debitNormal={debitNormal} opening={opening} openingLabel="Carried from earlier pages" totals={ledger.extra.totals} loading={ledger.loading} empty={ledger.search ? 'No posting matches that search.' : 'No postings for this account in range.'} />
            <PaginationControls {...ledger.pager} />
          </>
        ) : (
          <div className="space-y-3">
            {journal.pagination.total > 0 && (
              <p className="text-sm text-gray-600 tabular-nums">{journal.pagination.total.toLocaleString()} journal{journal.pagination.total === 1 ? '' : 's'} · Total posted <span className="font-semibold text-gray-900">{money(journal.extra.summary?.debit)}</span></p>
            )}
            {journals.map((j) => (
              <div key={j.id} className="rounded-2xl border border-gray-200 bg-white p-4">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="text-sm font-semibold text-gray-900">#{j.id} · {j.memo || 'Journal'}</span>
                    {j.source_type && <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase text-gray-500">{j.source_type}</span>}
                  </div>
                  <span className="text-xs text-gray-500">{formatNepalDate(j.entry_date)}{j.created_by_name ? ` · ${j.created_by_name}` : ''}</span>
                </div>
                <table className="w-full text-sm">
                  <thead><tr className="border-t border-gray-100 text-xs uppercase tracking-wide text-gray-400"><th className="py-1.5 text-left font-medium">Code</th><th className="py-1.5 text-left font-medium">Account</th><th className="py-1.5 text-right font-medium">Debit</th><th className="py-1.5 text-right font-medium">Credit</th></tr></thead>
                  <tbody>
                    {(j.lines || []).map((l) => {
                      const debitAdds = DEBIT_NORMAL.has(l.account_type);
                      return <tr key={l.id} className="border-t border-gray-100">
                        <td className="py-1.5 text-gray-500">{l.account_code}</td>
                        <td className="py-1.5 text-gray-900">{l.account_name}</td>
                        <JournalAmount value={l.debit} added={debitAdds} />
                        <JournalAmount value={l.credit} added={!debitAdds} />
                      </tr>
                    })}
                  </tbody>
                </table>
              </div>
            ))}
            {!journal.loading && journals.length === 0 && <div className="rounded-2xl border border-gray-200 bg-white p-10 text-center text-gray-500">{journal.search ? 'No journal matches that search.' : 'No journals in range.'}</div>}
            <PaginationControls {...journal.pager} />
          </div>
        )}
      </div>
    </AdminLayout>
  );
}

function JournalAmount({ value, added }) {
  if (!Number(value)) return <td className="py-1.5 text-right" />;
  return <td className={`py-1.5 text-right font-semibold tabular-nums ${added ? 'text-emerald-700' : 'text-rose-700'}`}>{added ? '+' : '−'}{money(value)}</td>;
}
