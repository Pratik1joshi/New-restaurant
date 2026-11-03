'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Download, X } from 'lucide-react';
import { formatNepalDateTime, formatNepalDisplay } from '@/lib/report-dates';
import { toCsv } from '@/lib/csv.js';

const TABS = [
  ['overview', 'Overview'],
  ['dishes', 'Dishes & sales'],
  ['purchases', 'Purchases'],
  ['wastage', 'Wastage'],
  ['movements', 'Stock movements'],
  ['portions', 'Possible portions'],
];

const qty = (value) => Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const money = (value) => `Rs ${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const MOVEMENT_LABELS = {
  purchase_receipt: 'Purchase received', manual_restock: 'Purchase received', order_deduction: 'Used by order',
  order_void: 'Restored from order', wastage: 'Wastage', opening_balance: 'Opening entry',
  kitchen_use: 'Kitchen use', kitchen_use_reversal: 'Kitchen use reversed',
  stock_count: 'Stock count', manual_adjustment: 'Manual adjustment', adjustment: 'Adjustment', correction: 'Correction',
};
const movementLabel = (type) => MOVEMENT_LABELS[type] || String(type || '').replace(/_/g, ' ');

/** Side drawer for one ingredient in the Ingredient Usage report. */
export default function IngredientDrawer({ ingredientId, range, basePath = '/admin', onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('overview');

  useEffect(() => {
    const controller = new AbortController();
    const q = new URLSearchParams({ id: String(ingredientId), startDate: range.start, endDate: range.end });
    fetch(`/api/admin/reports/ingredient?${q}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('pos_token')}` },
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Could not load this ingredient.');
        setData(body);
      })
      .catch((loadError) => { if (loadError.name !== 'AbortError') setError(loadError.message); });
    return () => controller.abort();
  }, [ingredientId, range.start, range.end]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event) => { if (event.key === 'Escape') onClose(); };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const unit = data?.item?.unit || '';
  const s = data?.summary;
  const u = (value) => `${qty(value)} ${unit}`.trim();

  // Each tab is one table; the CSV button downloads whichever tab is open.
  const tables = data ? {
    dishes: {
      columns: [['Dish', (d) => d.dish_name], ['Portions sold', (d) => qty(d.portions_sold)], [`Uses per portion (${unit})`, (d) => qty(d.per_portion)], [`Expected use (${unit})`, (d) => qty(d.expected_use)], ['Dish sales', (d) => money(d.sales)]],
      rows: data.dishes,
      empty: 'No active recipe uses this ingredient.',
    },
    purchases: {
      columns: [['Date', (p) => formatNepalDisplay(String(p.invoice_date).slice(0, 10))], ['Invoice', (p) => p.invoice_number || `Purchase #${p.purchase_id}`], ['Supplier', (p) => p.supplier], [`Quantity (${data.item.purchase_unit || unit})`, (p) => qty(p.quantity_received)], ['Unit cost', (p) => money(p.unit_cost)], ['Line total', (p) => money(p.line_total)], ['Status', (p) => p.status || 'received']],
      rows: data.purchases,
      empty: 'Nothing of this ingredient was purchased in this period.',
    },
    wastage: {
      columns: [['When', (w) => formatNepalDateTime(w.created_at)], ['Quantity', (w) => `${qty(w.quantity)} ${w.unit || unit}`], ['Reason', (w) => w.reason || '—'], ['Cost', (w) => money(w.total_cost)], ['Logged by', (w) => w.logged_by_name || '—'], ['Status', (w) => w.status || 'active']],
      rows: data.wastage,
      empty: 'No wastage of this ingredient was recorded in this period.',
    },
    movements: {
      columns: [['When', (m) => formatNepalDateTime(m.created_at)], ['What happened', (m) => movementLabel(m.change_type)], [`Change (${unit})`, (m) => `${m.quantity_changed > 0 ? '+' : ''}${qty(m.quantity_changed)}`], [`Stock after (${unit})`, (m) => (m.balance_after == null ? '—' : qty(m.balance_after))], ['Note', (m) => m.reason || (m.reference_id ? `Ref #${m.reference_id}` : '—')], ['By', (m) => m.performed_by_name || 'System']],
      rows: data.movements,
      empty: 'This ingredient did not move in this period.',
    },
    portions: {
      columns: [['Dish', (d) => d.dish_name], [`Uses per portion (${unit})`, (d) => qty(d.per_portion)], ['Portions possible from current stock', (d) => qty(d.possible_portions)]],
      rows: data.dishes,
      empty: 'No active recipe uses this ingredient, so no portions can be estimated.',
    },
  } : {};
  const activeTable = tables[tab];

  const downloadCsv = () => {
    let headers;
    let rows;
    if (tab === 'overview') {
      headers = ['Line', `Quantity (${unit})`];
      rows = steps().map(([label, value]) => ({ Line: label, [headers[1]]: qty(value) }));
    } else {
      headers = activeTable.columns.map(([label]) => label);
      rows = activeTable.rows.map((row) => Object.fromEntries(activeTable.columns.map(([label, read]) => [label, read(row)])));
    }
    const blob = new Blob([toCsv(headers, rows)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `ingredient-${data.item.item_name}-${tab}-${range.start}.csv`.replace(/[^\w.-]+/g, '-');
    link.click();
    URL.revokeObjectURL(url);
  };

  const steps = () => [
    ['Opening stock', s.opening],
    ['+ Received purchases', s.received],
    ['− Purchase reversals', s.reversals],
    ['− Used by orders', s.deducted],
    ['+ Restored from voided orders', s.restored],
    ['− Wastage', s.wastage],
    ['− Kitchen use (tasting, staff meals, samples)', s.kitchen_use],
    ['± Other adjustments (opening entries, stock counts, corrections)', s.other],
    ['Closing stock', s.closing],
  ];

  return (
    <div className="fixed inset-0 z-[80] flex justify-end">
      <button type="button" aria-label="Close ingredient details" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <aside role="dialog" aria-modal="true" aria-labelledby="ingredient-detail-title" className="relative z-10 flex h-full w-full max-w-3xl flex-col bg-white shadow-2xl animate-in fade-in duration-200 motion-reduce:animate-none">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-gray-200 px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Ingredient details</p>
            <h2 id="ingredient-detail-title" className="mt-0.5 break-words text-lg font-semibold text-gray-950 sm:text-xl">{data?.item?.item_name || 'Loading…'}</h2>
            <p className="mt-1 text-sm text-gray-500">
              Purchases, dish sales and stock for {formatNepalDisplay(range.start)} – {formatNepalDisplay(range.end)}.{unit ? ` Quantities shown in ${unit}.` : ''}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {data && (tab === 'overview' || activeTable?.rows.length > 0) && (
              <button type="button" onClick={downloadCsv} className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-gray-300 px-3 text-sm font-medium text-gray-700 hover:bg-gray-50">
                <Download className="h-4 w-4" /> CSV
              </button>
            )}
            <button type="button" onClick={onClose} className="inline-flex h-10 w-10 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-900" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>
        </header>

        <nav aria-label="Ingredient detail sections" className="flex shrink-0 gap-1 overflow-x-auto border-b border-gray-200 px-3 sm:px-5">
          {TABS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-current={tab === id ? 'page' : undefined}
              onClick={() => setTab(id)}
              className={`whitespace-nowrap border-b-2 px-3 py-3 text-sm font-medium ${tab === id ? 'border-gray-900 text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-800'}`}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="flex-1 overflow-y-auto p-5 sm:p-6">
          {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p>
            : !data ? <p role="status" className="py-12 text-center text-sm text-gray-500">Loading ingredient history…</p>
              : tab === 'overview' ? (
                <div className="space-y-6">
                  <section className="grid gap-3 sm:grid-cols-3">
                    <Stat label="Received" value={u(s.net_received)} note={`${money(s.received_value)} net receipt value`} />
                    <Stat label="Used by sold dishes" value={u(s.used)} note={`${qty(s.portions_sold)} portions · ${s.usage_basis}`} />
                    <Stat label="Closing stock" value={u(s.closing)} note="Recorded balance at the end of this period" />
                  </section>
                  <section className="rounded-xl border border-gray-200">
                    <h3 className="border-b border-gray-100 px-4 py-3 text-sm font-semibold text-gray-900">Stock balance, step by step</h3>
                    <dl className="divide-y divide-gray-100 text-sm">
                      {steps().map(([label, value], index, all) => (
                        <div key={label} className={`flex justify-between gap-4 px-4 py-2.5 ${index === 0 || index === all.length - 1 ? 'bg-gray-50 font-semibold text-gray-900' : 'text-gray-700'}`}>
                          <dt>{label}</dt>
                          <dd className="tabular-nums">{u(value)}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                  <section className="rounded-xl border border-gray-200 p-4">
                    <h3 className="text-sm font-semibold text-gray-900">Physical stock count</h3>
                    {data.counts.length ? (
                      <ul className="mt-2 space-y-1 text-sm text-gray-700">
                        {data.counts.map((c) => (
                          <li key={c.id}>
                            {formatNepalDateTime(c.created_at)} · {movementLabel(c.change_type)} · stock set to {c.balance_after == null ? '—' : u(c.balance_after)}
                            {c.variance ? ` (difference ${c.variance > 0 ? '+' : ''}${u(c.variance)})` : ''}{c.reason ? ` · ${c.reason}` : ''}
                          </li>
                        ))}
                      </ul>
                    ) : <p className="mt-1 text-sm text-gray-500">No physical stock count was recorded for this ingredient during this period.</p>}
                  </section>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => setTab('dishes')} className="h-10 rounded-lg bg-gray-900 px-4 text-sm font-semibold text-white hover:bg-gray-800">See dishes and sales</button>
                    <Link href={`${basePath}/inventory/${data.item.id}`} className="inline-flex h-10 items-center rounded-lg border border-gray-300 px-4 text-sm font-medium text-gray-700 hover:bg-gray-50">Open inventory item</Link>
                  </div>
                </div>
              ) : (
                <DetailTable table={activeTable} />
              )}
        </div>
      </aside>
    </div>
  );
}

function Stat({ label, value, note }) {
  return (
    <div className="rounded-xl border border-gray-200 p-4">
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className="mt-1 text-xl font-bold tabular-nums text-gray-950">{value}</p>
      <p className="mt-1 text-xs text-gray-500">{note}</p>
    </div>
  );
}

function DetailTable({ table }) {
  if (!table.rows.length) return <p className="py-12 text-center text-sm text-gray-500">{table.empty}</p>;
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
          <tr>{table.columns.map(([label], i) => <th key={label} className={`whitespace-nowrap px-3 py-2.5 ${i ? 'text-right' : ''}`}>{label}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {table.rows.map((row, index) => (
            <tr key={index}>
              {table.columns.map(([label, read], i) => <td key={label} className={`px-3 py-2.5 ${i ? 'whitespace-nowrap text-right tabular-nums' : 'text-gray-900'}`}>{read(row)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
