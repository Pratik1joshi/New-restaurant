'use client';

import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, HandCoins, ShieldX, X } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { friendlyMessage, friendlyFromError } from '@/lib/friendly-message';
import { apiJson } from '@/lib/authed-fetch';

const money = (n) => `Rs ${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

/**
 * Settle (staff paid cash/online) or waive (admin forgives) a staff member's
 * food credit. Both go through the normal Accounts Receivable flow, after a
 * review step and an explicit confirmation.
 */
export default function FoodCreditActions({ customerId, staffName, outstanding, staffActive = true, canWaive = false, onDone, size = 'md' }) {
  const [mode, setMode] = useState(null);
  const due = round2(outstanding);
  if (!(due > 0)) return null;
  const btn = size === 'sm' ? 'h-8 px-2.5 text-xs' : 'h-9 px-3 text-sm';
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setMode('settle')} className={`inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 font-semibold text-white hover:bg-emerald-700 active:scale-[0.98] ${btn}`}>
          <HandCoins className="h-4 w-4" /> Settle
        </button>
        {canWaive && (
          <button type="button" onClick={() => setMode('waive')} className={`inline-flex items-center gap-1.5 rounded-lg border border-rose-300 bg-white font-semibold text-rose-700 hover:bg-rose-50 active:scale-[0.98] ${btn}`}>
            <ShieldX className="h-4 w-4" /> Waive
          </button>
        )}
      </div>
      {mode && <FoodCreditModal mode={mode} customerId={customerId} staffName={staffName} due={due} staffActive={staffActive}
        onClose={() => setMode(null)} onDone={() => { setMode(null); onDone?.(); }} />}
    </>
  );
}

function FoodCreditModal({ mode, customerId, staffName, due, staffActive, onClose, onDone }) {
  const { addToast } = useToast();
  const waive = mode === 'waive';
  const [step, setStep] = useState('form');
  const [amount, setAmount] = useState(String(due));
  const [method, setMethod] = useState('cash');
  const [note, setNote] = useState('');
  const [checked, setChecked] = useState(false);
  const [typed, setTyped] = useState('');
  const [saving, setSaving] = useState(false);
  const requestKey = useRef(null);
  const value = round2(amount);
  const after = round2(due - value);

  const review = (event) => {
    event.preventDefault();
    if (!(value > 0) || value > due) return addToast(friendlyMessage('validation', { description: `Enter an amount between Rs 0.01 and ${money(due)}.` }));
    if (waive && note.trim().length < 5) return addToast(friendlyMessage('validation', { description: 'Write a clear reason for the waiver (at least 5 characters).' }));
    setStep('review');
  };

  const submit = async () => {
    setSaving(true);
    requestKey.current ||= crypto.randomUUID();
    try {
      await apiJson('/api/admin/accounts-receivable', {
        method: 'POST',
        body: JSON.stringify(waive
          ? { action: 'writeoff', customer_id: customerId, amount: value, reason: `Staff food credit waived: ${note.trim()}`, note: note.trim(), external_ref: requestKey.current }
          : { customer_id: customerId, amount: value, method, note: note.trim() || `Staff food credit settled by ${staffName}`, external_ref: requestKey.current }),
      });
      addToast(friendlyMessage('save_success', { description: waive ? `${money(value)} of food credit waived.` : `${money(value)} food credit settled.` }));
      onDone();
    } catch (error) {
      addToast(friendlyFromError(error, 'save_failed'));
    } finally {
      setSaving(false);
    }
  };

  const confirmReady = checked && (!waive || typed.trim().toUpperCase() === 'WAIVE');
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end justify-center p-0 sm:items-center sm:p-4">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/50" onClick={saving ? undefined : onClose} />
      <div role="dialog" aria-modal="true" aria-label={waive ? 'Waive food credit' : 'Settle food credit'} className="relative z-10 w-full max-w-md rounded-t-2xl bg-white shadow-xl sm:rounded-2xl">
        <header className={`flex items-start justify-between gap-3 rounded-t-2xl px-5 py-4 ${waive ? 'bg-rose-50' : 'bg-emerald-50'}`}>
          <div>
            <p className={`text-xs font-semibold uppercase tracking-wide ${waive ? 'text-rose-700' : 'text-emerald-700'}`}>{waive ? 'Waive food credit' : 'Settle food credit'}</p>
            <h2 className="text-lg font-bold text-gray-900">{staffName}</h2>
            <p className="text-sm text-gray-600">Outstanding food credit: <strong>{money(due)}</strong>{!staffActive && ' · staff has left'}</p>
          </div>
          <button type="button" onClick={onClose} disabled={saving} className="rounded-lg p-1.5 text-gray-500 hover:bg-white/70" aria-label="Close"><X className="h-5 w-5" /></button>
        </header>

        {step === 'form' ? (
          <form onSubmit={review} className="space-y-4 p-5">
            <label className="block">
              <span className="text-sm font-medium text-gray-700">{waive ? 'Amount to waive (Rs)' : 'Amount received (Rs)'}</span>
              <input type="number" min="0.01" max={due} step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} className={INPUT} autoFocus />
              <span className="mt-1 flex gap-2">
                <button type="button" onClick={() => setAmount(String(due))} className="text-xs font-medium text-blue-700 hover:underline">Full amount</button>
              </span>
            </label>
            {!waive && (
              <label className="block">
                <span className="text-sm font-medium text-gray-700">Received by</span>
                <select value={method} onChange={(e) => setMethod(e.target.value)} className={INPUT}>
                  <option value="cash">Cash (drawer)</option>
                  <option value="online">Bank / Online</option>
                </select>
              </label>
            )}
            <label className="block">
              <span className="text-sm font-medium text-gray-700">{waive ? 'Reason (required)' : 'Note'}</span>
              <input value={note} onChange={(e) => setNote(e.target.value)} required={waive} minLength={waive ? 5 : undefined} className={INPUT}
                placeholder={waive ? 'e.g. Final settlement agreed with owner' : 'Optional'} />
            </label>
            {waive && <p className="flex gap-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-900"><AlertTriangle className="h-4 w-4 shrink-0" /> A waiver is booked as a write-off expense. The bills stay in history with this reason.</p>}
            <div className="flex gap-2">
              <button type="button" onClick={onClose} className="h-10 flex-1 rounded-lg border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
              <button type="submit" className={`h-10 flex-1 rounded-lg text-sm font-semibold text-white ${waive ? 'bg-rose-600 hover:bg-rose-700' : 'bg-emerald-600 hover:bg-emerald-700'}`}>Review</button>
            </div>
          </form>
        ) : (
          <div className="space-y-4 p-5">
            <div className="rounded-xl border border-gray-200 text-sm">
              <Row label="Staff">{staffName}</Row>
              <Row label="Food credit now">{money(due)}</Row>
              <Row label={waive ? 'Waived' : `Received (${method === 'cash' ? 'Cash' : 'Bank / Online'})`} strong>{money(value)}</Row>
              <Row label="Food credit after">{money(after)}</Row>
              {note.trim() && <Row label={waive ? 'Reason' : 'Note'}>{note.trim()}</Row>}
            </div>
            <label className="flex items-start gap-2 text-sm text-gray-800">
              <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="mt-0.5 h-4 w-4" />
              {waive ? 'I understand this money will not be collected.' : `I have received ${money(value)} from ${staffName}.`}
            </label>
            {waive && (
              <label className="block">
                <span className="text-sm text-gray-700">Type <strong>WAIVE</strong> to confirm</span>
                <input value={typed} onChange={(e) => setTyped(e.target.value)} className={INPUT} autoComplete="off" />
              </label>
            )}
            <div className="flex gap-2">
              <button type="button" onClick={() => setStep('form')} disabled={saving} className="h-10 flex-1 rounded-lg border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50">Back</button>
              <button type="button" onClick={submit} disabled={!confirmReady || saving}
                className={`inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-lg text-sm font-semibold text-white disabled:opacity-40 ${waive ? 'bg-rose-600 hover:bg-rose-700' : 'bg-emerald-600 hover:bg-emerald-700'}`}>
                <CheckCircle2 className="h-4 w-4" /> {saving ? 'Saving…' : waive ? 'Confirm waiver' : 'Confirm settlement'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>, document.body
  );
}

const INPUT = 'mt-1 h-10 w-full rounded-lg border border-gray-300 px-3 text-sm text-gray-900';
function Row({ label, strong, children }) {
  return <div className="flex justify-between gap-3 border-b border-gray-100 px-4 py-2.5 last:border-0"><span className="text-gray-500">{label}</span><span className={`text-right ${strong ? 'font-bold text-gray-900' : 'text-gray-800'}`}>{children}</span></div>;
}
