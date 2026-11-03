'use client';

import { useEffect, useMemo, useState } from 'react';
import { FlaskConical, Plus, Trash2, Wine, ChefHat, ArrowRight, Check } from 'lucide-react';
import Combobox from '@/components/ui/combobox';
import { apiJson } from '@/lib/authed-fetch';
import { useToast } from '@/components/ui/toast';

const money = (n) => `Rs. ${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const field = 'h-11 w-full rounded-xl border border-gray-200 bg-white px-3 text-sm text-gray-950 disabled:bg-gray-50 disabled:text-gray-500';
const blank = () => ({ inventory_item_id: '', quantity: '', unit: '' });
const newKey = () => typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

export default function RecipeTrialStudio({ options, canViewCost, canApprove, onRecorded }) {
  const { addToast } = useToast();
  const [name, setName] = useState('');
  const [studio, setStudio] = useState('kitchen');
  const [lines, setLines] = useState([blank()]);
  const [target, setTarget] = useState('');
  const [instructions, setInstructions] = useState('');
  const [notes, setNotes] = useState('');
  const [plan, setPlan] = useState(null);
  const [clientKey, setClientKey] = useState(newKey);
  const [trials, setTrials] = useState([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [previewState, setPreviewState] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const started = plan?.status === 'started';
  const completed = plan?.status === 'confirmed';
  const locked = Boolean(busy) || completed;
  const ingredients = useMemo(() => options.ingredients || [], [options.ingredients]);
  const byId = useMemo(() => new Map(ingredients.map((i) => [String(i.id), i])), [ingredients]);
  const items = useMemo(() => lines.map((line) => ({ source_mode: 'ingredient', inventory_item_id: Number(line.inventory_item_id), quantity: Number(line.quantity), unit: line.unit || byId.get(String(line.inventory_item_id))?.unit || null })), [lines, byId]);
  const fingerprint = JSON.stringify(items);
  const ready = name.trim() && items.length && items.every((i) => i.inventory_item_id && Number.isFinite(i.quantity) && i.quantity > 0);
  const preview = previewState?.key === fingerprint ? previewState.data : null;
  const liveError = previewError?.key === fingerprint ? previewError.message : '';

  const refresh = () => apiJson('/api/admin/recipe-trials').then((data) => setTrials(data.trials || []));
  useEffect(() => {
    let active = true;
    apiJson('/api/admin/recipe-trials').then((data) => { if (active) setTrials(data.trials || []); }).catch((e) => { if (active) setError(e.error || e.message); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!items.length || !items.every((i) => i.inventory_item_id && Number.isFinite(i.quantity) && i.quantity > 0)) return;
    let active = true;
    const timer = setTimeout(() => {
      apiJson('/api/admin/kitchen-use', { method: 'POST', body: JSON.stringify({ action: 'preview', consumption_type: 'recipe_testing', items }) })
        .then((data) => { if (active) { setPreviewState({ key: fingerprint, data }); setPreviewError(null); } })
        .catch((e) => { if (active) { setPreviewState(null); setPreviewError({ key: fingerprint, message: e.error || e.message }); } });
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [items, fingerprint]);

  const update = (index, patch) => setLines((current) => current.map((line, i) => i === index ? { ...line, ...patch } : line));
  const reset = () => { setName(''); setStudio('kitchen'); setLines([blank()]); setTarget(''); setInstructions(''); setNotes(''); setPlan(null); setClientKey(newKey()); setError(''); };
  const open = (id) => {
    if (!id) { reset(); return; }
    const trial = trials.find((t) => String(t.id) === id);
    if (!trial) return;
    setPlan(trial); setName(trial.name); setStudio(trial.studio); setLines(trial.ingredients); setTarget(trial.target_price ?? ''); setInstructions(trial.instructions || ''); setClientKey(trial.client_key); setNotes(trial.tasting_notes || ''); setError('');
  };
  const save = async (status) => {
    const { trial } = await apiJson('/api/admin/recipe-trials', { method: 'POST', body: JSON.stringify({ action: 'save', name, studio, ingredients: items, target_price: target, instructions, status, client_key: clientKey }) });
    setPlan(trial);
    return trial;
  };
  const act = async (action) => {
    if (busy) return;
    setBusy(action); setError('');
    try {
      if (action === 'draft' || action === 'planned') {
        await save(action);
        addToast({ title: action === 'draft' ? 'Recipe draft saved' : 'Trial planned', description: 'No inventory has been consumed.', variant: 'success' });
      } else if (action === 'start') {
        const saved = await save('planned');
        const { trial } = await apiJson('/api/admin/recipe-trials', { method: 'POST', body: JSON.stringify({ action: 'start', id: saved.id }) });
        setPlan(trial);
      } else {
        const { record } = await apiJson('/api/admin/recipe-trials', { method: 'POST', body: JSON.stringify({ action: 'confirm', id: plan.id, ingredients: items, notes }) });
        setPlan((current) => ({ ...current, status: 'confirmed', consumption_id: record.id, consumption_status: record.status }));
        addToast({ title: record.status === 'posted' ? 'Trial usage confirmed' : 'Trial sent for approval', description: record.reference_number, variant: 'success' });
        onRecorded?.();
      }
      // A list refresh failure must not make a successful posting look failed.
      await refresh().catch(() => {});
    } catch (e) { setError(e.error || e.message || 'Could not save trial.'); }
    finally { setBusy(''); }
  };
  const cost = preview?.estimated_cost;
  const costPercent = cost != null && Number(target) > 0 ? cost / Number(target) * 100 : null;
  const waiting = preview?.approval_required && !canApprove;
  const shortages = preview?.short_items || [];

  return (
    <section className="mx-auto max-w-5xl overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm" aria-label="New recipe trial">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-5 py-5 sm:px-7">
        <div><p className="text-[10px] font-bold uppercase tracking-[0.18em] text-teal-700">AADHAR POS / Recipe Studio</p><h2 className="mt-1 text-xl font-semibold text-gray-950">New recipe trial</h2></div>
        <span role="status" className="rounded-full border border-teal-200 bg-teal-50 px-3 py-1 text-xs font-semibold text-teal-800">{completed ? 'Usage confirmed' : started ? 'Trial in progress' : plan?.status === 'planned' ? 'Trial planned' : 'Draft recipe'}</span>
      </div>
      <div className="space-y-6 p-5 sm:p-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-xl bg-gray-100 p-1" role="group" aria-label="Studio">
            {[['bar', 'Bar Studio', Wine], ['kitchen', 'Kitchen Studio', ChefHat]].map(([id, label, Icon]) => <button key={id} type="button" disabled={locked || started} aria-pressed={studio === id} onClick={() => setStudio(id)} className={`inline-flex h-10 items-center gap-2 rounded-lg px-4 text-sm font-semibold ${studio === id ? 'bg-white text-teal-800 shadow-sm' : 'text-gray-500'}`}><Icon className="h-4 w-4" />{label}</button>)}
          </div>
          <select aria-label="Open saved recipe trial" value={plan?.id || ''} disabled={Boolean(busy)} onChange={(e) => open(e.target.value)} className={`${field} max-w-xs`}><option value="">New recipe trial</option>{trials.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.status})</option>)}</select>
        </div>
        <label className="block text-sm font-semibold text-gray-800">Recipe name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} disabled={locked || started} maxLength={160} placeholder={studio === 'bar' ? 'e.g. Orange sunset mocktail' : 'e.g. Roasted tomato soup'} className={`${field} mt-2 h-12`} /></label>
        <div>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold text-gray-900">{started ? 'Actual ingredients used' : 'Ingredient builder'}</h3><span className="text-xs text-gray-500">{canViewCost ? 'Current inventory valuation' : 'Choose from inventory'}</span></div>
          <div className="space-y-2">
            {lines.map((line, index) => {
              const item = byId.get(String(line.inventory_item_id));
              const units = [...new Set([item?.unit, item?.purchase_unit].filter(Boolean))];
              const factor = line.unit && line.unit !== item?.unit ? Number(item?.conversion_factor || 1) : 1;
              const rate = item?.unit_cost == null ? null : Number(item.unit_cost) * factor;
              return <div key={index} className="grid grid-cols-[1fr_1fr_auto] items-end gap-3 rounded-xl border border-gray-200 bg-gray-50/50 p-3 lg:grid-cols-[minmax(0,1fr)_90px_80px_100px_36px] sm:p-4">
                <div className="col-span-3 min-w-0 lg:col-span-1"><label className="mb-1.5 block text-xs font-medium text-gray-500">Ingredient {index + 1}</label><Combobox aria-label={`Ingredient ${index + 1}`} value={String(line.inventory_item_id || '')} onChange={(value) => update(index, { inventory_item_id: value, unit: byId.get(value)?.unit || '' })} options={ingredients.map((i) => ({ value: String(i.id), label: i.name }))} allowCustom={false} disabled={locked} placeholder="Select ingredient" className="w-full" portal />{canViewCost && rate != null && <p className="mt-1.5 text-xs text-gray-500">{money(rate)} / {line.unit || item.unit}</p>}</div>
                <label className="text-xs font-medium text-gray-500">Quantity<input aria-label={`Quantity for ingredient ${index + 1}`} type="number" min="0" step="any" value={line.quantity} disabled={locked} onChange={(e) => update(index, { quantity: e.target.value })} placeholder="0" className={`${field} mt-1.5`} /></label>
                <label className="text-xs font-medium text-gray-500">Unit<select aria-label={`Unit for ingredient ${index + 1}`} value={line.unit || item?.unit || ''} disabled={locked || !item} onChange={(e) => update(index, { unit: e.target.value })} className={`${field} mt-1.5`}>{!units.length && <option value="">Unit</option>}{units.map((unit) => <option key={unit} value={unit}>{unit}</option>)}</select></label>
                <div className="hidden pb-3 text-right text-sm font-semibold tabular-nums text-gray-800 lg:block">{canViewCost && rate != null ? money(Number(line.quantity) * rate) : ''}</div>
                <button type="button" aria-label={`Remove ingredient ${index + 1}`} disabled={locked || lines.length === 1} onClick={() => setLines((current) => current.filter((_, i) => i !== index))} className="mb-1 rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-700 disabled:opacity-30"><Trash2 className="h-4 w-4" /></button>
              </div>;
            })}
          </div>
          <button type="button" disabled={locked || lines.length >= 100} onClick={() => setLines((current) => [...current, blank()])} className="mt-3 inline-flex h-10 items-center gap-2 rounded-lg border border-dashed border-gray-300 px-4 text-sm font-semibold text-gray-700 hover:border-teal-500 hover:text-teal-800"><Plus className="h-4 w-4" />Add ingredient</button>
        </div>
        <div className="grid gap-5 rounded-2xl border border-teal-100 bg-teal-50/50 p-5 sm:grid-cols-3">
          <div><p className="text-xs font-medium text-gray-500">Estimated ingredient cost</p><p className="mt-2 text-3xl font-semibold tracking-tight text-gray-950">{canViewCost ? cost == null ? '--' : money(cost) : 'Cost restricted'}</p></div>
          <label className="text-xs font-medium text-gray-500">Target selling price (Rs.)<input type="number" min="0" step="0.01" value={target} disabled={locked || started} onChange={(e) => setTarget(e.target.value)} placeholder="e.g. 450" className={`${field} mt-2`} /></label>
          <div><p className="text-xs font-medium text-gray-500">Estimated ingredient cost %</p><p className="mt-2 text-3xl font-semibold tracking-tight text-teal-800">{canViewCost && costPercent != null ? `${costPercent.toFixed(1)}%` : '--'}</p></div>
        </div>
        <p className="text-xs leading-relaxed text-gray-500">Costs come from inventory valuation. Saving a draft, planning or starting a trial does not deduct stock. Only confirmed usage is posted, subject to approval.</p>
        <label className="block text-xs font-medium text-gray-600">Preparation instructions (optional)<textarea rows={2} value={instructions} disabled={locked || started} onChange={(e) => setInstructions(e.target.value)} className="mt-2 w-full rounded-xl border border-gray-200 p-3 text-sm" /></label>
        {(started || completed) && <label className="block text-xs font-medium text-gray-600">Tasting notes and result<textarea rows={3} value={notes} disabled={locked} onChange={(e) => setNotes(e.target.value)} placeholder="Taste, appearance, preparation time and what to change" className="mt-2 w-full rounded-xl border border-gray-200 p-3 text-sm" /></label>}
        {(error || liveError) && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error || liveError}</p>}
        {!completed && shortages.length > 0 && <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">Insufficient stock: {shortages.join(', ')}. You can save or plan this recipe; confirmation needs sufficient inventory.</p>}
        {completed && <p role="status" className="flex items-center gap-2 rounded-xl bg-emerald-50 p-4 text-sm text-emerald-800"><Check className="h-4 w-4" />{plan.consumption_status === 'pending_approval' ? 'Usage recorded and waiting for approval. No stock deducted yet.' : `Usage recorded (${plan.consumption_status}). Open the consumption register for details.`}</p>}
      </div>
      <div className="flex flex-wrap justify-end gap-3 border-t border-gray-100 bg-gray-50/50 px-5 py-4 sm:px-7">
        {completed ? <button type="button" onClick={reset} className="rounded-xl bg-teal-700 px-5 py-3 text-sm font-semibold text-white">New recipe trial</button> : started ? <button type="button" onClick={() => act('confirm')} disabled={locked || !ready || !preview || shortages.length > 0} className="inline-flex items-center gap-2 rounded-xl bg-teal-700 px-5 py-3 text-sm font-semibold text-white disabled:opacity-40"><Check className="h-4 w-4" />{busy ? 'Confirming...' : waiting ? 'Confirm & send for approval' : 'Confirm usage'}</button> : <>
          <button type="button" onClick={() => act('draft')} disabled={locked || !ready} className="rounded-xl border border-gray-300 bg-white px-5 py-3 text-sm font-semibold text-gray-700 disabled:opacity-40">{busy === 'draft' ? 'Saving...' : 'Save draft'}</button>
          <button type="button" onClick={() => act('planned')} disabled={locked || !ready} className="inline-flex items-center gap-2 rounded-xl bg-gray-900 px-5 py-3 text-sm font-semibold text-white disabled:opacity-40"><FlaskConical className="h-4 w-4" />{busy === 'planned' ? 'Planning...' : 'Plan trial'}</button>
          {plan?.status === 'planned' && <button type="button" onClick={() => act('start')} disabled={locked || !ready} className="inline-flex items-center gap-2 rounded-xl bg-teal-700 px-5 py-3 text-sm font-semibold text-white disabled:opacity-40">{busy === 'start' ? 'Starting...' : 'Start trial'}<ArrowRight className="h-4 w-4" /></button>}
        </>}
      </div>
    </section>
  );
}
