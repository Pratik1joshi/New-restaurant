'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowLeft, ChevronLeft, ChevronRight, Download, FileSpreadsheet, Printer, Search } from 'lucide-react';
import AdminLayout from '@/components/admin/admin-layout';
import PayrollDrawer from '@/components/employees/payroll-drawer';
import { KpiCards } from '@/components/admin/report-kit';
import { useToast } from '@/components/ui/toast';
import { friendlyFromError } from '@/lib/friendly-message';
import { apiJson } from '@/lib/authed-fetch';
import { useCapabilities } from '@/lib/use-capabilities';
import { nepalDateString } from '@/lib/report-dates.js';
import { downloadReport } from '@/lib/report-export.js';
import { loadPrintSettings } from '@/lib/print-report.js';

const money = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const shiftMonth = (month, by) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const monthLabel = (month) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// One definition drives the screen, the totals, Excel/CSV and the print sheet.
const COLUMNS = [
  { key: 'opening', label: 'Opening', type: 'currency', hint: 'Unpaid salary (+) or deduction (−) from earlier months' },
  { key: 'salary', label: 'Salary', type: 'currency' },
  { key: 'absences', label: 'Absence', type: 'currency', minus: true },
  { key: 'advanced', label: 'Advances', type: 'currency', minus: true },
  { key: 'food_deducted', label: 'Food deducted', type: 'currency', minus: true },
  { key: 'waived', label: 'Waived', type: 'currency' },
  { key: 'paid', label: 'Paid', type: 'currency', minus: true },
  { key: 'balance', label: 'Balance', type: 'currency', strong: true },
];
const SIDE = [
  { key: 'food_taken', label: 'Food taken (month)', type: 'currency' },
  { key: 'food_outstanding', label: 'Food credit due', type: 'currency' },
  { key: 'advance_outstanding', label: 'Advance due', type: 'currency' },
];
const ALL = [...COLUMNS, ...SIDE];

export default function StaffSheetPage() {
  const pathname = usePathname();
  const base = pathname?.startsWith('/cashier') ? '/cashier' : '/admin';
  const { can, loading: permissionsLoading } = useCapabilities();
  const { addToast } = useToast();
  const [month, setMonth] = useState(nepalDateString().slice(0, 7));
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('active');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);
  const canView = can('payroll.view');

  const load = async () => {
    setLoading(true);
    try {
      const data = await apiJson(`/api/admin/payroll?view=sheet&month=${month}`);
      setRows((data.employees || []).map((e) => ({
        ...e,
        name: e.full_name || e.username,
        title: e.position || e.role,
        opening: e.statement.opening, salary: e.statement.salary, absences: e.statement.absences,
        advanced: e.statement.advanced, food_deducted: e.statement.food_deducted, waived: e.statement.waived,
        paid: e.statement.paid, balance: e.statement.balance,
        food_outstanding: round2(e.food_outstanding), advance_outstanding: round2(e.advance_outstanding),
      })));
    } catch (error) {
      addToast(friendlyFromError(error, 'load_failed'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (permissionsLoading || !canView) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permissionsLoading, canView, month]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      const active = Number(r.is_active) === 1;
      if (status === 'active' && !active) return false;
      if (status === 'left' && active) return false;
      return !q || `${r.name} ${r.title} ${r.phone || ''}`.toLowerCase().includes(q);
    });
  }, [rows, status, search]);

  const totals = useMemo(() => Object.fromEntries(ALL.map((c) => [c.key, round2(visible.reduce((n, r) => n + Number(r[c.key] || 0), 0))])), [visible]);
  const absentDays = visible.reduce((n, r) => n + Number(r.absent_days || 0), 0);

  const exportSheet = (format) => {
    const columns = [
      { key: 'name', label: 'Staff' }, { key: 'title', label: 'Position' }, { key: 'phone', label: 'Phone' },
      { key: 'absent_days', label: 'Absent days' },
      ...ALL.map((c) => ({ key: c.key, label: c.label, type: 'currency' })),
    ];
    const records = visible.map((r) => ({ ...Object.fromEntries(columns.map((c) => [c.key, c.type ? round2(r[c.key]) : (r[c.key] ?? '')])), absent_days: Number(r.absent_days || 0) }));
    records.push({ name: 'TOTAL', title: '', phone: '', absent_days: absentDays, ...totals });
    downloadReport(`staff-sheet-${month}`, format, 'Staff Sheet', [{ title: monthLabel(month), columns, rows: records }],
      [['Salary month (AD)', monthLabel(month)], ['Staff', status === 'active' ? 'Active staff' : status === 'left' ? 'Staff who left' : 'All staff'], ['Generated', nepalDateString()]]);
  };

  const printSheet = async () => {
    const settings = await loadPrintSettings();
    const head = ['#', 'Staff', 'Absent', ...COLUMNS.map((c) => c.label), 'Food due', 'Signature'];
    const body = visible.map((r, i) => `<tr><td>${i + 1}</td><td><b>${esc(r.name)}</b><br><small>${esc(r.title || '')}</small></td><td class="n">${Number(r.absent_days || 0) || ''}</td>${COLUMNS.map((c) => `<td class="n${c.strong ? ' b' : ''}">${money(r[c.key])}</td>`).join('')}<td class="n">${money(r.food_outstanding)}</td><td class="sig"></td></tr>`).join('');
    const foot = `<tr class="t"><td></td><td>TOTAL (${visible.length})</td><td class="n">${absentDays || ''}</td>${COLUMNS.map((c) => `<td class="n">${money(totals[c.key])}</td>`).join('')}<td class="n">${money(totals.food_outstanding)}</td><td></td></tr>`;
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Staff Sheet ${esc(month)}</title><style>
      @page{size:A4 landscape;margin:12mm}body{font:11px/1.35 system-ui,Segoe UI,Arial,sans-serif;color:#111;margin:0}
      h1{font-size:18px;margin:0}.sub{color:#555;margin:2px 0 12px}table{width:100%;border-collapse:collapse}
      th,td{border:1px solid #bbb;padding:5px 6px;vertical-align:top}th{background:#111;color:#fff;text-align:left;font-weight:600}
      .n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.b{font-weight:700}.sig{width:90px}
      tr:nth-child(even) td{background:#f5f5f5}.t td{font-weight:700;background:#e5e7eb!important}small{color:#666}
      .foot{display:flex;justify-content:space-between;margin-top:36px}.foot span{border-top:1px solid #333;padding-top:4px;width:180px;text-align:center}
    </style></head><body>
      <h1>${esc(settings.restaurant_name || 'Staff Sheet')}</h1>
      <p class="sub">Staff Sheet · ${esc(monthLabel(month))} (AD) · Balance = Opening + Salary − Absence − Advances − Food deducted + Waived − Paid. Negative balance carries forward as a deduction.</p>
      <table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table>
      <div class="foot"><span>Prepared by</span><span>Checked by</span><span>Approved by</span></div>
    </body></html>`;
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    document.body.appendChild(frame);
    frame.contentDocument.open();
    frame.contentDocument.write(html);
    frame.contentDocument.close();
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 1000);
  };

  if (!permissionsLoading && !canView) {
    return <AdminLayout><div className="p-8 text-sm text-gray-600">You do not have permission to view the staff sheet.</div></AdminLayout>;
  }

  const balanceDue = round2(visible.reduce((n, r) => n + Math.max(0, Number(r.balance || 0)), 0));
  return (
    <AdminLayout>
      <header className="border-b border-gray-200 bg-white px-4 py-5 sm:px-6 lg:px-8">
        <Link href={`${base}/payroll`} className="mb-2 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900"><ArrowLeft className="h-4 w-4" /> Salary &amp; Advances</Link>
        <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 sm:text-3xl">Staff Sheet</h1>
            <p className="mt-1 text-sm text-gray-500">Monthly salary, deductions, food credit and payments for every staff member.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex h-10 items-center rounded-lg border border-gray-300 bg-white">
              <button type="button" onClick={() => setMonth(shiftMonth(month, -1))} className="h-full px-2.5 text-gray-600 hover:bg-gray-50" aria-label="Previous month"><ChevronLeft className="h-4 w-4" /></button>
              <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="h-full border-x border-gray-200 px-2 text-sm text-gray-900" aria-label="Salary month (AD)" />
              <button type="button" onClick={() => setMonth(shiftMonth(month, 1))} className="h-full px-2.5 text-gray-600 hover:bg-gray-50" aria-label="Next month"><ChevronRight className="h-4 w-4" /></button>
            </div>
            <button type="button" onClick={() => exportSheet('excel')} disabled={!visible.length} className={BTN}><FileSpreadsheet className="h-4 w-4" /> Excel</button>
            <button type="button" onClick={() => exportSheet('csv')} disabled={!visible.length} className={BTN}><Download className="h-4 w-4" /> CSV</button>
            <button type="button" onClick={printSheet} disabled={!visible.length} className={`${BTN} border-gray-900 bg-gray-900 text-white hover:bg-gray-800`}><Printer className="h-4 w-4" /> Print / PDF</button>
          </div>
        </div>
      </header>

      <main className="space-y-5 bg-gray-50 p-4 sm:p-6 lg:p-8">
        <KpiCards kpis={[
          { key: 'salary', label: `Salary · ${monthLabel(month)}`, value: totals.salary, format: 'currency', icon: 'wallet' },
          { key: 'deductions', label: 'Deductions (absence, advance, food)', value: round2(totals.absences + totals.advanced + totals.food_deducted - totals.waived), format: 'currency', icon: 'warn' },
          { key: 'paid', label: 'Paid this month', value: totals.paid, format: 'currency', icon: 'positive' },
          { key: 'due', label: 'Still to pay', value: balanceDue, format: 'currency', icon: 'info' },
        ]} />

        <section className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
          <div className="flex flex-col gap-3 border-b border-gray-200 p-4 sm:flex-row sm:items-center">
            <label className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} className="h-10 w-full rounded-lg border border-gray-300 pl-9 pr-3 text-sm" placeholder="Search staff, position or phone…" />
            </label>
            <div className="inline-flex rounded-lg bg-gray-100 p-1 text-sm">
              {[['active', 'Active'], ['left', 'Left'], ['all', 'All']].map(([id, label]) => (
                <button key={id} type="button" onClick={() => setStatus(id)} className={`rounded-md px-3 py-1.5 font-medium ${status === id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>{label}</button>
              ))}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[1180px] text-sm">
              <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="sticky left-0 z-10 bg-gray-50 px-4 py-3 text-left font-semibold">Staff</th>
                  <th className="px-3 py-3 text-right font-semibold">Absent</th>
                  {COLUMNS.map((c) => <th key={c.key} title={c.hint} className={`px-3 py-3 text-right font-semibold ${c.strong ? 'text-gray-900' : ''}`}>{c.label}</th>)}
                  <th className="border-l border-gray-200 px-3 py-3 text-right font-semibold">Food taken</th>
                  <th className="px-3 py-3 text-right font-semibold">Food due</th>
                  <th className="px-3 py-3 text-right font-semibold">Advance due</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading && rows.length === 0 && <tr><td colSpan={13} className="px-5 py-12 text-center text-gray-500">Loading…</td></tr>}
                {visible.map((r) => (
                  <tr key={r.id} onClick={() => setSelected(r)} className="group cursor-pointer hover:bg-gray-50">
                    <td className="sticky left-0 z-10 bg-white px-4 py-3 group-hover:bg-gray-50">
                      <p className="flex items-center gap-1.5 font-medium text-gray-900">{r.name}
                        {Number(r.is_active) !== 1 && <span className="rounded-full bg-gray-200 px-1.5 py-0.5 text-[10px] font-semibold text-gray-700">Left</span>}
                        {Number(r.can_login) === 0 && <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">No login</span>}
                      </p>
                      <p className="text-xs capitalize text-gray-500">{r.title}{r.phone ? ` · ${r.phone}` : ''}</p>
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-gray-700">{Number(r.absent_days || 0) || '—'}</td>
                    {COLUMNS.map((c) => <Cell key={c.key} value={r[c.key]} column={c} />)}
                    <td className="border-l border-gray-100 px-3 py-3 text-right tabular-nums text-gray-700">{money(r.food_taken)}</td>
                    <td className={`px-3 py-3 text-right tabular-nums ${r.food_outstanding > 0 ? 'font-semibold text-indigo-700' : 'text-gray-400'}`}>{money(r.food_outstanding)}</td>
                    <td className={`px-3 py-3 text-right tabular-nums ${r.advance_outstanding > 0 ? 'font-semibold text-amber-700' : 'text-gray-400'}`}>{money(r.advance_outstanding)}</td>
                  </tr>
                ))}
                {!loading && visible.length === 0 && <tr><td colSpan={13} className="px-5 py-12 text-center text-gray-500">No staff match these filters.</td></tr>}
              </tbody>
              {visible.length > 0 && (
                <tfoot className="border-t-2 border-gray-300 bg-gray-100 font-semibold text-gray-900">
                  <tr>
                    <td className="sticky left-0 z-10 bg-gray-100 px-4 py-3">Total · {visible.length} staff</td>
                    <td className="px-3 py-3 text-right tabular-nums">{absentDays || '—'}</td>
                    {COLUMNS.map((c) => <td key={c.key} className="px-3 py-3 text-right tabular-nums">{money(totals[c.key])}</td>)}
                    {SIDE.map((c, i) => <td key={c.key} className={`px-3 py-3 text-right tabular-nums ${i === 0 ? 'border-l border-gray-200' : ''}`}>{money(totals[c.key])}</td>)}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <p className="border-t border-gray-100 px-4 py-3 text-xs text-gray-500">
            Balance = Opening + Salary − Absence − Advances − Food deducted + Waived − Paid. A negative balance carries to next month as a deduction. Food due and Advance due are today&apos;s totals. Click a row to manage that staff member.
          </p>
        </section>
      </main>

      {selected && <PayrollDrawer employee={selected} initialAction="salary" onClose={() => { setSelected(null); load(); }}
        canRecordSalary={can('payroll.payments.create')} canGiveAdvance={can('payroll.advances.create')} canDelete={can('payroll.records.delete')} />}
    </AdminLayout>
  );
}

const BTN = 'inline-flex h-10 items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40';

function Cell({ value, column }) {
  const n = Number(value || 0);
  const tone = column.strong
    ? (n < 0 ? 'text-rose-700' : n > 0 ? 'text-gray-900' : 'text-gray-400')
    : n === 0 ? 'text-gray-300' : column.minus ? 'text-gray-700' : 'text-gray-900';
  return <td className={`px-3 py-3 text-right tabular-nums ${column.strong ? 'font-bold' : ''} ${tone}`}>{column.minus && n > 0 ? '−' : ''}{money(value)}</td>;
}
