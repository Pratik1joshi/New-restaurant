'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Download, Plus, Soup, X, FlaskConical, Users, Coffee, UtensilsCrossed, Gift, RefreshCw } from 'lucide-react';
import AdminLayout from '@/components/admin/admin-layout';
import WorkspaceHeader, { RecipeWorkspaceNav } from '@/components/admin/workspace-header';
import { KpiCards } from '@/components/admin/report-kit';
import RecipeTrialStudio from '@/components/inventory/recipe-trial-studio';
import Combobox from '@/components/ui/combobox';
import DateInput from '@/components/ui/date-input.jsx';
import { useToast } from '@/components/ui/toast';
import { apiJson } from '@/lib/authed-fetch';
import { downloadReport } from '@/lib/report-export.js';
import { nepalDateString, formatNepalDateTime, formatNepalDisplay } from '@/lib/report-dates';

const money = (value) => (value == null ? '—' : `Rs ${Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const qty = (value) => Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const control = 'h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900';
const STATUS = {
  pending_approval: ['Waiting approval', 'bg-amber-50 text-amber-800 border-amber-200'],
  posted: ['Posted', 'bg-emerald-50 text-emerald-800 border-emerald-200'],
  rejected: ['Rejected', 'bg-gray-100 text-gray-600 border-gray-200'],
  reversed: ['Reversed', 'bg-red-50 text-red-700 border-red-200'],
};
const ACTIVITIES = [
  { id: 'recipe_testing', label: 'Recipe trial', description: 'Measure actual ingredients and record the result.', icon: FlaskConical },
  { id: 'chef_tasting', label: 'Quality tasting', description: 'Record measured ingredient use for a taste check.', icon: UtensilsCrossed },
  { id: 'staff_meal', label: 'Staff meal', description: 'Track food prepared for your team.', icon: Users },
  { id: 'owner_use', label: 'Owner / family', description: 'Keep personal consumption traceable.', icon: Coffee },
  { id: 'guest_sample', label: 'Guest sample', description: 'Record a complimentary sample outside an order.', icon: Gift },
];
const DEFAULT_REASON = {
  chef_tasting: 'Taste check before service',
  recipe_testing: 'Testing a recipe',
  staff_meal: 'Staff meal',
  owner_use: 'Owner / family meal',
  guest_sample: 'Free sample for guests',
};

function StatusBadge({ status }) {
  const [label, tone] = STATUS[status] || [status, 'bg-gray-100 text-gray-600 border-gray-200'];
  return <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold ${tone}`}>{label}</span>;
}

function KitchenWorkspaceLayout({ children }) {
  return <div className="admin-page-content min-h-screen"><div className="border-b border-gray-200 bg-white px-4 py-3 sm:px-6 lg:px-8"><Link href="/kitchen" className="inline-flex min-h-10 items-center gap-2 text-sm font-semibold text-gray-600 hover:text-teal-700">Back to kitchen</Link></div>{children}</div>;
}

export default function KitchenUsePage({ kitchenWorkspace = false }) {
  const Layout = kitchenWorkspace ? KitchenWorkspaceLayout : AdminLayout;
  const { addToast } = useToast();
  const today = nepalDateString();
  const [filters, setFilters] = useState({ from: today, to: today, type: '', status: '', search: '' });
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [recordOpen, setRecordOpen] = useState(false);
  const [studioOpen, setStudioOpen] = useState(true);
  const [detailId, setDetailId] = useState(null);

  const query = useCallback((extra = {}) => {
    const q = new URLSearchParams({ page: String(page), page_size: '50', options: '1', ...extra });
    for (const [key, value] of Object.entries(filters)) if (value) q.set(key, value);
    return q;
  }, [filters, page]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await apiJson(`/api/admin/kitchen-use?${query()}`));
    } catch (error) {
      setError(error.error || error.message || 'Could not load kitchen use.');
      addToast({ title: 'Could not load kitchen use', description: error.error || error.message, variant: 'error' });
    } finally {
      setLoading(false);
    }
  }, [query, addToast]);
  useEffect(() => { load(); }, [load]);

  const setFilter = (key, value) => { setFilters((f) => ({ ...f, [key]: value })); setPage(1); };
  const access = data?.access || {};
  const types = data?.types || [];
  const summary = data?.summary;

  const exportCsv = async (format = 'csv') => {
    try {
      const all = await apiJson(`/api/admin/kitchen-use?${query({ export: '1', options: '0' })}`);
      const headers = ['Date', 'Reference', 'Type', 'Item', 'Quantity', 'Unit', ...(access.canViewCost ? ['Cost'] : []), 'Reason', 'Recorded by', 'Status'];
      const rows = all.rows.map((r) => ({
        Date: formatNepalDisplay(String(r.use_date).slice(0, 10)), Reference: r.reference_number, Type: r.type_label, Item: r.item_label,
        Quantity: Number(r.quantity), Unit: r.unit || '', ...(access.canViewCost ? { Cost: Number(r.posted_cost ?? r.estimated_cost ?? 0) } : {}),
        Reason: r.reason, 'Recorded by': r.recorded_by_name || '', Status: (STATUS[r.status] || [r.status])[0],
      }));
      downloadReport(`kitchen-use-${filters.from || 'all'}-${filters.to || 'all'}`, format, 'Kitchen Use', [{ title: 'Tasting and kitchen use', columns: headers.map((key) => ({ key, label: key, ...(key === 'Cost' ? { type: 'currency' } : {}) })), rows }], [['From', filters.from || 'All dates'], ['To', filters.to || 'All dates'], ['Currency', 'NPR']]);
    } catch (error) {
      addToast({ title: 'CSV failed', description: error.error || error.message, variant: 'error' });
    }
  };

  return (
    <Layout>
      <WorkspaceHeader eyebrow="Recipe studio" title={studioOpen ? 'Recipe tasting & testing' : 'Testing & internal use'} icon={Soup}
        description="Give every experiment a record. Track actual ingredient use, review costs, and keep meals and tastings organised."
        actions={<>
          <button type="button" onClick={() => exportCsv('csv')} disabled={!data || loading} className={control}><Download className="mr-1.5 inline h-4 w-4" />CSV</button>
          <button type="button" onClick={() => exportCsv('excel')} disabled={!data || loading} className={control}>Excel</button>
          {access.canCreate && <button type="button" onClick={() => setStudioOpen((open) => !open)} className="inline-flex h-10 items-center gap-2 rounded-lg bg-teal-700 px-4 text-sm font-semibold text-white hover:bg-teal-800"><FlaskConical className="h-4 w-4" />{studioOpen ? 'Consumption register' : 'New recipe trial'}</button>}
        </>}>
        <RecipeWorkspaceNav active="consumption" />
      </WorkspaceHeader>

      <main className="space-y-5 bg-gray-50 p-4 sm:p-6 lg:p-8">
        {error && <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700"><span>{error}</span><button type="button" onClick={load} className="shrink-0 font-semibold underline">Try again</button></div>}
        {studioOpen && access.canCreate && data?.options ? <RecipeTrialStudio options={data.options} canViewCost={access.canViewCost} canApprove={access.canApprove} onRecorded={load} /> : <>
        <KpiCards kpis={[
          ...(access.canViewCost ? [
            { key: 'cost', label: 'Internal consumption', value: summary?.posted_cost, format: 'currency', sub: 'Posted cost for selected filters', highlight: true },
            { key: 'trial', label: 'Recipe testing cost', value: summary ? (summary.by_type?.recipe_testing || 0) : null, format: 'currency', sub: 'Actual posted ingredient cost' },
          ] : []),
          { key: 'posted', label: 'Records posted', value: summary?.posted_count, format: 'number', sub: 'Inventory consumption recorded' },
          { key: 'pending', label: 'Waiting approval', value: summary?.pending_count, format: 'number', sub: 'Stock has not been deducted' },
        ]} />
        {access.canCreate && <section className="rounded-2xl border border-gray-200 bg-white p-4 sm:p-5">
          <div className="mb-4 flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-teal-600" /><h2 className="text-sm font-semibold text-gray-950">What are you recording?</h2></div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
            {ACTIVITIES.filter((activity) => types.some((type) => type.id === activity.id)).map(({ id, label, description, icon: Icon }) => <button key={id} type="button" onClick={() => id === 'recipe_testing' ? setStudioOpen(true) : setRecordOpen(id)} className="group rounded-xl border border-gray-200 bg-gray-50/50 p-4 text-left hover:border-teal-300 hover:bg-teal-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"><Icon className="mb-3 h-5 w-5 text-teal-700" /><span className="flex items-center justify-between gap-2 text-sm font-semibold text-gray-900">{label}<Plus className="h-3.5 w-3.5 text-gray-400 group-hover:text-teal-700" /></span><span className="mt-1.5 block text-xs leading-relaxed text-gray-500">{description}</span></button>)}
          </div>
          <p className="mt-4 text-xs leading-relaxed text-gray-500">Use the recipe library to build a recipe without consuming stock. Record a trial after preparation with the quantities actually used. Posting or approval consumes stock without creating a sale.</p>
        </section>}
        {access.canViewCost && summary && <section className="rounded-2xl border border-gray-200 bg-white p-4 sm:p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold text-gray-950">Where ingredients went</h2><span className="text-xs text-gray-500">Posted cost for selected filters</span></div>
          {Number(summary.posted_cost) > 0 ? <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
            {types.map((type) => {
              const value = Number(summary.by_type?.[type.id] || 0);
              const share = summary.posted_cost > 0 ? value / summary.posted_cost * 100 : 0;
              return <button key={type.id} type="button" onClick={() => setFilter('type', filters.type === type.id ? '' : type.id)} aria-pressed={filters.type === type.id} className="rounded-lg p-2 text-left hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-teal-600"><span className="mb-2 flex justify-between gap-2 text-xs"><span className="font-medium text-gray-700">{type.label}</span><span className="tabular-nums text-gray-500">{money(value)} <span className="ml-1 text-gray-400">{share.toFixed(0)}%</span></span></span><span className="block h-1.5 overflow-hidden rounded-full bg-gray-100"><span className="block h-full rounded-full bg-teal-600" style={{ width: Math.min(100, Math.max(0, share)) + '%' }} /></span></button>;
            })}
          </div> : <p className="py-5 text-sm text-gray-500">No posted consumption for these filters. Recorded costs will appear here.</p>}
        </section>}

        <section className="rounded-2xl border border-gray-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3"><div><h2 className="text-sm font-semibold text-gray-950">Consumption register</h2><p className="mt-1 text-xs text-gray-500">Open a record to review ingredients, approval and corrections.</p></div><button type="button" onClick={load} disabled={loading} aria-label="Refresh consumption" className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 disabled:opacity-40"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button></div>
          <div className="flex flex-wrap items-end gap-2 border-b border-gray-100 p-4">
            <label className="text-xs font-medium text-gray-600">From<DateInput value={filters.from} onChange={(v) => setFilter('from', v)} className={`${control} mt-1 block`} /></label>
            <label className="text-xs font-medium text-gray-600">To<DateInput value={filters.to} onChange={(v) => setFilter('to', v)} className={`${control} mt-1 block`} /></label>
            <select aria-label="Type" value={filters.type} onChange={(e) => setFilter('type', e.target.value)} className={control}>
              <option value="">All types</option>
              {types.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
            <select aria-label="Status" value={filters.status} onChange={(e) => setFilter('status', e.target.value)} className={control}>
              <option value="">Any status</option>
              {Object.entries(STATUS).map(([id, [label]]) => <option key={id} value={id}>{label}</option>)}
            </select>
            <input type="search" aria-label="Search consumption records" placeholder="Search item, reason, person…" value={filters.search} onChange={(e) => setFilter('search', e.target.value)} className={`${control} min-w-[200px] flex-1`} />
            {access.canManageSettings && data?.options && <ThresholdSetting value={data.options.threshold} onSaved={load} />}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-3">Date</th><th className="px-4 py-3">Ref</th><th className="px-4 py-3">Type</th><th className="px-4 py-3">Item</th>
                  <th className="px-4 py-3 text-right">Quantity</th>{access.canViewCost && <th className="px-4 py-3 text-right">Cost</th>}
                  <th className="px-4 py-3">Recorded by</th><th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(data?.rows || []).map((r) => (
                  <tr key={r.id} tabIndex={0} onClick={() => setDetailId(r.id)} onKeyDown={(e) => { if (e.key === 'Enter') setDetailId(r.id); }} className="cursor-pointer hover:bg-gray-50 focus:bg-gray-50 focus:outline-none">
                    <td className="whitespace-nowrap px-4 py-3 text-gray-600">{formatNepalDisplay(String(r.use_date).slice(0, 10))}</td>
                    <td className="px-4 py-3 font-medium text-gray-900">{r.reference_number}</td>
                    <td className="px-4 py-3">{r.type_label}</td>
                    <td className="px-4 py-3">{r.item_label}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">{qty(r.quantity)} {r.unit}</td>
                    {access.canViewCost && <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">{money(r.posted_cost ?? r.estimated_cost)}</td>}
                    <td className="px-4 py-3 text-gray-600">{r.recorded_by_name || '—'}</td>
                    <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!loading && !error && !data?.rows?.length && <p className="py-12 text-center text-sm text-gray-500">Nothing recorded for these dates.</p>}
            {loading && !data && <p className="py-12 text-center text-sm text-gray-500">Loading…</p>}
          </div>
          {data?.pagination?.total_pages > 1 && (
            <div className="flex items-center justify-between border-t border-gray-100 px-4 py-3 text-sm">
              <span className="text-gray-500">Page {page} of {data.pagination.total_pages}</span>
              <div className="flex gap-2">
                <button type="button" className={control} disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
                <button type="button" className={control} disabled={!data.pagination.has_more} onClick={() => setPage(page + 1)}>Next</button>
              </div>
            </div>
          )}
        </section>
        </>}
      </main>

      {recordOpen && data?.options && (
        <RecordModal initialType={recordOpen} types={types.filter((type) => type.id !== 'recipe_testing')} options={data.options} canViewCost={access.canViewCost} canApprove={access.canApprove}
          onClose={() => setRecordOpen(false)}
          onSaved={(record) => {
            setRecordOpen(false);
            addToast({ title: record.status === 'posted' ? `${record.reference_number} posted` : `${record.reference_number} sent for approval`, description: record.status === 'posted' ? 'Stock has been taken out.' : 'Stock comes out once it is approved.', variant: 'success' });
            load();
          }} />
      )}
      {detailId && <DetailDrawer id={detailId} access={access} onClose={() => setDetailId(null)} onChanged={load} />}
    </Layout>
  );
}

function ThresholdSetting({ value, onSaved }) {
  const { addToast } = useToast();
  const [draft, setDraft] = useState(String(value ?? ''));
  const save = async () => {
    try {
      await apiJson('/api/admin/kitchen-use', { method: 'POST', body: JSON.stringify({ action: 'settings', threshold: Number(draft) }) });
      addToast({ title: 'Approval limit saved', variant: 'success' });
      onSaved();
    } catch (error) {
      addToast({ title: 'Could not save', description: error.error || error.message, variant: 'error' });
    }
  };
  return (
    <label className="text-xs font-medium text-gray-600" title="Records above this cost wait for approval. Owner use always waits. 0 = only owner use waits.">
      Approval above (Rs)
      <span className="mt-1 flex gap-1">
        <input type="number" min="0" value={draft} onChange={(e) => setDraft(e.target.value)} className={`${control} w-28`} />
        <button type="button" onClick={save} className={control}>Save</button>
      </span>
    </label>
  );
}

function RecordModal({ initialType = 'chef_tasting', types, options, canViewCost, canApprove, onClose, onSaved }) {
  const [type, setType] = useState(initialType);
  const [lines, setLines] = useState([{ key: 1, mode: initialType === 'recipe_testing' ? 'ingredient' : 'dish', itemId: '', quantity: '1', unit: '' }]);
  const [reason, setReason] = useState(DEFAULT_REASON[initialType]);
  const [notes, setNotes] = useState('');
  const [previewState, setPreview] = useState(null);
  const [previewErrorState, setPreviewError] = useState('');
  const [saving, setSaving] = useState(false);
  // One key per opened form: a double-click or retry posts once. randomUUID is
  // missing on plain-http LAN addresses, hence the fallback.
  const [clientKey] = useState(() => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`));

  const updateLine = (key, patch) => setLines((current) => current.map((line) => line.key === key ? { ...line, ...patch } : line));
  const ready = lines.every((line) => line.itemId && Number(line.quantity) > 0);
  const input = useMemo(() => ({ consumption_type: type, items: lines.map((line) => ({
    source_mode: line.mode, quantity: Number(line.quantity),
    ...(line.mode === 'dish' ? { menu_item_id: Number(line.itemId) } : line.mode === 'recipe' ? { recipe_id: Number(line.itemId) } : { inventory_item_id: Number(line.itemId), unit: line.unit || null }),
  })) }), [type, lines]);
  const inputKey = JSON.stringify(input);
  const preview = ready && previewState?.inputKey === inputKey ? previewState.result : null;
  const previewError = previewErrorState?.inputKey === inputKey ? previewErrorState.message : '';

  useEffect(() => {
    if (!ready) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      apiJson('/api/admin/kitchen-use', { method: 'POST', body: JSON.stringify({ action: 'preview', ...input }) })
        .then((p) => { if (!cancelled) { setPreview({ inputKey, result: p }); setPreviewError(''); } })
        .catch((e) => { if (!cancelled) { setPreview(null); setPreviewError({ inputKey, message: e.error || e.message || 'Could not work this out.' }); } });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [input, ready, inputKey]);

  const submit = async () => {
    setSaving(true);
    try {
      onSaved(await apiJson('/api/admin/kitchen-use', { method: 'POST', body: JSON.stringify({ ...input, reason, notes, client_key: clientKey }) }));
    } catch (error) {
      setPreviewError({ inputKey, message: error.error || error.message || 'Could not record this.' });
      setSaving(false);
    }
  };

  const willWait = preview?.approval_required && !canApprove;
  const blocked = !preview || preview.short_items?.length > 0 || !reason.trim() || saving;

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/40 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="ku-record-title">
      <div className="flex max-h-[92dvh] w-full max-w-3xl flex-col rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4">
          <h2 id="ku-record-title" className="text-lg font-semibold text-gray-950">{type === 'staff_meal' ? 'Record staff food' : type === 'owner_use' ? 'Record owner / family food' : type === 'recipe_testing' ? 'Record recipe trial' : 'Record Kitchen Use'}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-full p-2 text-gray-400 hover:bg-gray-100"><X className="h-5 w-5" /></button>
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          {type === 'recipe_testing' && <div className="rounded-xl border border-teal-200 bg-teal-50 p-4 text-sm text-teal-900"><p className="font-semibold">Record what you actually prepared</p><p className="mt-1 text-xs leading-relaxed">Add a saved recipe or the actual ingredients used, including extra usage. In Notes, record taste, appearance, preparation time and what to change. A failed trial still consumes ingredients.</p></div>}
          {type === 'chef_tasting' && <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs leading-relaxed text-amber-900">If a production batch already consumed the raw ingredients, select its prepared stock ingredient for tasting. Selecting the original dish or recipe would consume its raw ingredients again.</p>}
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">What was it for?</p>
            <div className="flex flex-wrap gap-2">
              {types.map((t) => (
                <button key={t.id} type="button" aria-pressed={type === t.id}
                  onClick={() => { if (reason === DEFAULT_REASON[type]) setReason(DEFAULT_REASON[t.id]); setType(t.id); }}
                  className={`rounded-lg border px-3 py-2 text-sm font-medium ${type === t.id ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'}`}>{t.label}</button>
              ))}
            </div>
          </div>
          <section className="space-y-3 rounded-2xl border border-gray-200 bg-gray-50 p-4">
            <div className="flex items-start justify-between gap-3">
              <div><h3 className="text-sm font-semibold text-gray-950">What was used?</h3><p className="mt-1 text-xs text-gray-500">Add menu items, ingredients or recipes. Stock and cost are combined below.</p></div>
              <span className="shrink-0 rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-gray-600">{lines.length} items</span>
            </div>
            {lines.map((line, index) => {
              const ingredient = line.mode === 'ingredient' ? options.ingredients.find((i) => String(i.id) === String(line.itemId)) : null;
              const recipe = line.mode === 'recipe' ? (options.recipes || []).find((i) => String(i.id) === String(line.itemId)) : null;
              const units = ingredient ? [...new Set([ingredient.unit, ingredient.purchase_unit].filter(Boolean))] : [];
              const choices = line.mode === 'dish' ? options.dishes : line.mode === 'recipe' ? (options.recipes || []) : options.ingredients;
              return <div key={line.key} className="space-y-3 rounded-xl border border-gray-200 bg-white p-3 shadow-sm sm:p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-gray-400">ITEM {index + 1}</span>
                  <div className="flex rounded-lg bg-gray-100 p-1">
                    {[['dish', 'Menu items'], ['ingredient', 'Ingredients'], ['recipe', 'Recipes']].map(([mode, label]) => <button key={mode} type="button" aria-pressed={line.mode === mode} onClick={() => updateLine(line.key, { mode, itemId: '', unit: '', quantity: '1' })} className={`rounded-md px-3 py-1.5 text-xs font-semibold ${line.mode === mode ? 'bg-white text-gray-950 shadow-sm' : 'text-gray-500 hover:text-gray-900'}`}>{label}</button>)}
                  </div>
                  <button type="button" disabled={lines.length === 1} aria-label={`Remove item ${index + 1}`} onClick={() => setLines((current) => current.filter((i) => i.key !== line.key))} className="rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-25"><X className="h-4 w-4" /></button>
                </div>
                <Combobox value={line.itemId} onChange={(itemId) => updateLine(line.key, { itemId, unit: '' })} options={choices.map((i) => ({ value: String(i.id), label: line.mode === 'ingredient' ? `${i.name} (${qty(i.quantity)} ${i.unit || ''} in stock)` : i.name }))} allowCustom={false} portal placeholder={`Search ${line.mode === 'dish' ? 'menu items' : line.mode === 'recipe' ? 'recipes' : 'ingredients'}…`} className="w-full" />
                <div className="flex flex-wrap items-end gap-3">
                  <label className="text-xs font-medium text-gray-600">{line.mode === 'dish' ? 'Portions' : 'Quantity'}<input aria-label={`Quantity for item ${index + 1}`} type="number" min="0" step="any" value={line.quantity} onChange={(e) => updateLine(line.key, { quantity: e.target.value })} className={`${control} mt-1 block w-28`} /></label>
                  {units.length > 0 && <label className="text-xs font-medium text-gray-600">Unit<select value={line.unit || ingredient.unit} onChange={(e) => updateLine(line.key, { unit: e.target.value })} className={`${control} mt-1 block`}>{units.map((u) => <option key={u} value={u}>{u}</option>)}</select></label>}
                  {recipe && <p className="pb-2 text-xs text-gray-500">{recipe.yield_unit || 'portion'} · recipe yields {qty(recipe.yield_quantity)} {recipe.yield_unit || 'portion'}</p>}
                </div>
              </div>;
            })}
            <button type="button" disabled={lines.length >= 100} onClick={() => setLines((current) => [...current, { key: Math.max(...current.map((i) => i.key)) + 1, mode: current.at(-1).mode, itemId: '', quantity: '1', unit: '' }])} className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-gray-300 bg-white py-3 text-sm font-semibold text-gray-700 hover:border-gray-500 hover:bg-gray-50 disabled:opacity-40"><Plus className="h-4 w-4" />Add another item</button>
          </section>

          <label className="block text-xs font-medium text-gray-600">Reason
            <input value={reason} onChange={(e) => setReason(e.target.value)} className={`${control} mt-1 block w-full`} />
          </label>
          <label className="block text-xs font-medium text-gray-600">Notes (optional)
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </label>

          {previewError && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{previewError}</p>}
          {preview && (
            <section className="rounded-xl border border-gray-200">
              <h3 className="border-b border-gray-100 px-4 py-2.5 text-sm font-semibold text-gray-900">This will take out</h3>
              <ul className="divide-y divide-gray-100 text-sm">
                {preview.components.map((c) => (
                  <li key={c.inventory_item_id} className={`flex justify-between gap-3 px-4 py-2 ${c.short ? 'bg-red-50 text-red-700' : ''}`}>
                    <span>{c.item_name}{c.short ? ` — only ${qty(c.available)} ${c.unit} in stock` : ''}</span>
                    <span className="tabular-nums">{qty(c.quantity)} {c.unit}{canViewCost ? ` · ${money(c.total_cost)}` : ''}</span>
                  </li>
                ))}
              </ul>
              {canViewCost && <p className="flex justify-between border-t border-gray-100 px-4 py-2.5 text-sm font-semibold"><span>Cost (at stock price, not menu price)</span><span>{money(preview.estimated_cost)}</span></p>}
              {willWait && <p className="border-t border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">This needs approval. Stock comes out only after it is approved.</p>}
            </section>
          )}
        </div>
        <div className="flex gap-2 border-t border-gray-200 p-4">
          <button type="button" onClick={onClose} className={`${control} flex-1 font-medium`}>Cancel</button>
          <button type="button" disabled={blocked} onClick={submit} className="h-10 flex-1 rounded-lg bg-gray-900 px-4 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-40">
            {saving ? 'Saving…' : willWait ? 'Send for approval' : 'Record and take out stock'}
          </button>
        </div>
      </div>
    </div>
  );
}

function DetailDrawer({ id, access, onClose, onChanged }) {
  const { addToast } = useToast();
  const [record, setRecord] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiJson(`/api/admin/kitchen-use/${id}`).then(setRecord).catch((e) => setError(e.error || e.message));
  }, [id]);

  const act = async (action) => {
    setBusy(true);
    try {
      const updated = await apiJson(`/api/admin/kitchen-use/${id}`, { method: 'POST', body: JSON.stringify({ action, note }) });
      setRecord(updated);
      setNote('');
      addToast({ title: `${updated.reference_number}: ${(STATUS[updated.status] || [updated.status])[0]}`, variant: 'success' });
      onChanged();
    } catch (e) {
      addToast({ title: 'Not done', description: e.error || e.message, variant: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const canDecide = record?.status === 'pending_approval' && access.canApprove;
  const canReverse = record?.status === 'posted' && access.canReverse;

  return (
    <div className="fixed inset-0 z-[80] flex justify-end">
      <button type="button" aria-label="Close details" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <aside role="dialog" aria-modal="true" className="relative z-10 flex h-full w-full max-w-xl flex-col overflow-y-auto bg-white shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-gray-200 px-5 py-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">{record?.reference_number || 'Kitchen use'}</p>
            <h2 className="mt-0.5 text-lg font-semibold text-gray-950">{record ? `${record.type_label}: ${record.item_label}` : 'Loading…'}</h2>
            {record && <div className="mt-2"><StatusBadge status={record.status} /></div>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-full p-2 text-gray-400 hover:bg-gray-100"><X className="h-5 w-5" /></button>
        </header>
        {error ? <p role="alert" className="m-5 rounded-lg bg-red-50 p-4 text-sm text-red-700">{error}</p> : record && (
          <div className="space-y-5 p-5">
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <Info label="Quantity" value={`${qty(record.quantity)} ${record.unit || ''}`} />
              {access.canViewCost && <Info label={record.status === 'pending_approval' ? 'Estimated cost' : 'Cost'} value={money(record.posted_cost ?? record.estimated_cost)} />}
              <Info label="Reason" value={record.reason} />
              <Info label="Business date" value={record.business_date ? formatNepalDisplay(String(record.business_date).slice(0, 10)) : '—'} />
              <Info label="Recorded by" value={`${record.recorded_by_name || '—'} · ${formatNepalDateTime(record.created_at)}`} />
              <Info label="Approved / decided by" value={record.approved_by_name ? `${record.approved_by_name}${record.approved_at ? ` · ${formatNepalDateTime(record.approved_at)}` : ''}` : '—'} />
              {record.notes && <Info label="Notes" value={record.notes} />}
              {record.decided_note && <Info label="Decision note" value={record.decided_note} />}
              {record.journal_id && <Info label="Journal" value={`#${record.journal_id}`} />}
              {record.status === 'reversed' && <Info label="Reversed" value={`${record.reversed_by_name || '—'} · ${formatNepalDateTime(record.reversed_at)} · ${record.reversal_reason}${record.reversal_journal_id ? ` (journal #${record.reversal_journal_id})` : ''}`} />}
            </dl>
            {record.items?.length > 0 && <section className="rounded-xl border border-gray-200">
              <h3 className="border-b border-gray-100 px-4 py-2.5 text-sm font-semibold">Items used</h3>
              <ul className="divide-y divide-gray-100 text-sm">{record.items.map((item, index) => <li key={index} className="flex justify-between gap-3 px-4 py-2"><span>{item.item_label}</span><span className="shrink-0 tabular-nums">{qty(item.quantity)} {item.unit}</span></li>)}</ul>
            </section>}
            {record.components?.length > 0 && (
              <section className="rounded-xl border border-gray-200">
                <h3 className="border-b border-gray-100 px-4 py-2.5 text-sm font-semibold">Stock taken out</h3>
                <ul className="divide-y divide-gray-100 text-sm">
                  {record.components.map((c) => (
                    <li key={c.id} className="flex justify-between gap-3 px-4 py-2">
                      <span>{c.item_name}</span>
                      <span className="tabular-nums">{qty(c.quantity)} {c.unit}{access.canViewCost ? ` · ${money(c.total_cost)}` : ''}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {record.status === 'pending_approval' && <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">No stock has been taken out yet. Approving takes it out at the stock price at that moment.</p>}
            {(canDecide || canReverse) && (
              <section className="space-y-2 rounded-xl border border-gray-200 p-4">
                <label className="block text-xs font-medium text-gray-600">{canReverse ? 'Why reverse it? (required)' : 'Note (required to reject)'}
                  <input value={note} onChange={(e) => setNote(e.target.value)} className={`${control} mt-1 block w-full`} />
                </label>
                <div className="flex gap-2">
                  {canDecide && <button type="button" disabled={busy} onClick={() => act('approve')} className="h-10 flex-1 rounded-lg bg-gray-900 text-sm font-semibold text-white disabled:opacity-40">Approve & take out stock</button>}
                  {canDecide && <button type="button" disabled={busy || !note.trim()} onClick={() => act('reject')} className={`${control} flex-1 font-medium disabled:opacity-40`}>Reject</button>}
                  {canReverse && <button type="button" disabled={busy || !note.trim()} onClick={() => act('reverse')} className="h-10 flex-1 rounded-lg border border-red-300 bg-red-50 text-sm font-semibold text-red-700 disabled:opacity-40">Reverse (put stock back)</button>}
                </div>
              </section>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

function Info({ label, value }) {
  return <div><dt className="text-xs font-medium text-gray-500">{label}</dt><dd className="mt-0.5 break-words text-gray-900">{value}</dd></div>;
}
