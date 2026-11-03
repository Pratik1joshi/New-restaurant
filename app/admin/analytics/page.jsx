'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  AlertCircle, CalendarDays, ClipboardList, Download, PackageSearch, Plus,
  RefreshCw, UtensilsCrossed, ChartNoAxesCombined,
} from 'lucide-react';
import AdminLayout from '@/components/admin/admin-layout';
import WorkspaceHeader from '@/components/admin/workspace-header';
import { analyticsReportHref } from '@/lib/analytics-links';
import OverviewDashboard from '@/components/analytics/overview-dashboard';
import { formatNepalDateTime } from '@/lib/report-dates';
import DateInput from '@/components/ui/date-input.jsx';
import { formatCalendarRangeLabel } from '@/lib/calendar-system.js';
import { useCalendarSystem } from '@/lib/calendar-context.jsx';
import { analyticsSections, downloadReport } from '@/lib/report-export.js';

const PERIODS = [
  ['today', 'Today'], ['yesterday', 'Yesterday'], ['last3', 'Last 3 Days'],
  ['last7', 'Last 7 Days'], ['last30', 'Last 30 Days'], ['this_week', 'This Week'],
  ['this_month', 'This Month'], ['last_month', 'Last Month'], ['custom', 'Custom Range'],
];

function todayNepal() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kathmandu' }).format(new Date());
}

export default function AnalyticsPage() {
  const { calendarSystem } = useCalendarSystem();
  const pathname = usePathname();
  const panelPrefix = pathname?.startsWith('/cashier') ? '/cashier' : '/admin';
  const [period, setPeriod] = useState('today');
  const [startDate, setStartDate] = useState(todayNepal());
  const [endDate, setEndDate] = useState(todayNepal());
  const [transactionPage, setTransactionPage] = useState(1);
  const [transactionPageSize, setTransactionPageSize] = useState(25);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        period,
        calendarSystem,
        transactionPage: String(transactionPage),
        transactionPageSize: String(transactionPageSize),
      });
      if (period === 'custom') {
        params.set('startDate', startDate);
        params.set('endDate', endDate);
      }
      const token = localStorage.getItem('pos_token');
      const response = await fetch(`/api/admin/analytics?${params}`, { headers: { Authorization: `Bearer ${token}` } });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not load restaurant analytics.');
      setData(body);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [period, startDate, endDate, transactionPage, transactionPageSize, calendarSystem]);

  useEffect(() => { loadOverview(); }, [loadOverview]);

  const choosePeriod = (id) => {
    setPeriod(id);
    setTransactionPage(1);
  };

  const exportTransactions = async (format = 'excel') => {
    if (!data || loading || exporting) return;
    setExporting(true);
    setExportError('');
    try {
      const params = new URLSearchParams({ period, export: 'analytics', calendarSystem });
      if (period === 'custom') {
        params.set('startDate', startDate);
        params.set('endDate', endDate);
      }
      const token = localStorage.getItem('pos_token');
      const response = await fetch(`/api/admin/analytics?${params}`, { headers: { Authorization: `Bearer ${token}` } });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not export transactions.');
      const range = body.range || data.range;
      const transactions = (body.recentTransactions || []).map((row) => ({ ...row, created_at: formatNepalDateTime(row.created_at) }));
      downloadReport(`restaurant-analytics-${range.start}-${range.end}`, format === 'csv' ? 'csv' : 'excel', 'Restaurant Analytics', analyticsSections(body, transactions), [
        ['Period', formatCalendarRangeLabel(range)], ['From', range.start], ['To', range.end], ['Currency', 'NPR'], ['Generated (NPT)', formatNepalDateTime(new Date())],
      ]);
    } catch (err) {
      setExportError(err.message || 'Could not export analytics.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <AdminLayout onPageCsvExport={() => exportTransactions('csv')}>
      <div className="min-h-screen bg-gray-50">
        <WorkspaceHeader eyebrow="Business intelligence" title="Restaurant Analytics" icon={ChartNoAxesCombined}
          description="See how your restaurant is performing, then explore the records behind every number."
          actions={<>
                <Link href={`${panelPrefix}/pos`} className="inline-flex h-9 items-center gap-1.5 rounded-md bg-gray-950 px-3 text-sm font-medium text-white active:scale-[0.98]"><Plus className="h-4 w-4" /> New Order</Link>
                <Link href={`${panelPrefix}/billing`} className="inline-flex h-9 items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 active:scale-[0.98]"><ClipboardList className="h-4 w-4" /> New Bill</Link>
                <Link href={`${panelPrefix}/leads`} className="inline-flex h-9 items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 active:scale-[0.98]"><UtensilsCrossed className="h-4 w-4" /> Reservations</Link>
                <Link href={analyticsReportHref('Table / bill duration', data?.range, panelPrefix)} className="inline-flex h-9 items-center rounded-md border border-gray-300 bg-white px-3 text-sm">Table / bill duration</Link>
                <Link href={`${panelPrefix}/inventory`} title="Inventory" className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-gray-300 bg-white text-gray-700 active:scale-[0.98]"><PackageSearch className="h-4 w-4" /></Link>
                <button type="button" onClick={() => exportTransactions('csv')} disabled={!data || loading || exporting} className="inline-flex h-9 items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 disabled:opacity-40"><Download className="h-4 w-4" /> CSV</button>
                <button type="button" onClick={() => exportTransactions('excel')} disabled={!data || loading || exporting} className="inline-flex h-9 items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 disabled:opacity-40"><Download className="h-4 w-4" />{exporting ? 'Exporting…' : 'Excel'}</button>
                <button type="button" onClick={loadOverview} title="Refresh analytics" className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-gray-300 bg-white text-gray-700 active:scale-[0.98]"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button>
</>}>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-gray-500">
            <span className="inline-flex items-center gap-1.5"><CalendarDays className="h-3.5 w-3.5" />{data?.range ? formatCalendarRangeLabel(data.range) : 'Select a reporting period'}</span>
            {data?.generatedAt && <span>Updated {formatNepalDateTime(data.generatedAt)} NPT</span>}
            {loading && <span role="status" className="font-medium text-teal-700">Updating analytics...</span>}
          </div>
        </WorkspaceHeader>

        <main className="mx-auto w-full min-w-0 max-w-[1680px] px-3 py-5 sm:px-6 lg:px-8">
          {exportError && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{exportError}</p>}
          <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap gap-1.5">
              {PERIODS.map(([id, label]) => <button key={id} type="button" onClick={() => choosePeriod(id)} aria-pressed={period === id} className={`rounded-md px-3.5 py-1.5 text-xs font-semibold transition-[background-color,color,border-color,transform] duration-150 active:scale-[0.98] ${period === id ? 'bg-gray-950 text-white shadow-sm' : 'border border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50'}`}>{label}</button>)}
            </div>
            {period === 'custom' && <div className="flex items-center gap-2"><DateInput value={startDate} max={endDate} onChange={(v) => { setStartDate(v); setTransactionPage(1); }} className="h-9 rounded-md border border-gray-300 bg-white px-2 text-sm" /><span className="text-xs text-gray-400">to</span><DateInput value={endDate} min={startDate} max={todayNepal()} onChange={(v) => { setEndDate(v); setTransactionPage(1); }} className="h-9 rounded-md border border-gray-300 bg-white px-2 text-sm" /></div>}
          </div>

          {error ? <ErrorState message={error} retry={loadOverview} /> : loading && !data ? <LoadingState /> : data ? (
          <OverviewDashboard
            data={data}
            panelPrefix={panelPrefix}
              transactionLoading={loading}
              onTransactionPageChange={setTransactionPage}
              onTransactionPageSizeChange={(size) => { setTransactionPageSize(size); setTransactionPage(1); }}
              onExportTransactions={() => exportTransactions('excel')}
            />
          ) : null}
        </main>
      </div>
    </AdminLayout>
  );
}

function LoadingState() {
  return <div className="space-y-5"><div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-6">{Array.from({ length: 6 }).map((_, index) => <div key={index} className="h-24 animate-pulse rounded-lg bg-gray-200" />)}</div><div className="h-64 animate-pulse rounded-lg bg-gray-200" /></div>;
}

function ErrorState({ message, retry }) {
  return <div className="flex flex-col items-center rounded-lg border border-red-200 bg-red-50 px-5 py-16 text-center"><AlertCircle className="h-8 w-8 text-red-500" /><p className="mt-3 text-sm text-red-800">{message}</p><button type="button" onClick={retry} className="mt-4 rounded-md bg-red-700 px-3 py-2 text-sm font-medium text-white">Try again</button></div>;
}
