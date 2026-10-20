'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApprovalCard, CATEGORY_ICON, CcyBadge, Donut, Icon, Sheet, money, type Json } from './ui';
import { CURRENCIES, Send as CompareProviders, api, type Ctx } from './views';
import { AlipayCheckout, StripeCheckout, useProviders } from './pay';

const CATS = ['food', 'rent', 'transport', 'bills', 'shopping', 'tuition', 'family', 'other'];
const key = () => `ui-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

/* ------------------------------------------------------------ transaction row */

export function TxRow({ t }: { t: Json }) {
  const incoming = !String(t.amount).startsWith('-');
  return (
    <div className="tx">
      <span className="emoji" aria-hidden="true">{CATEGORY_ICON[t.category] ?? '•'}</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.description}</div>
        <div className="faint small">{new Date(t.at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · <span style={{ textTransform: 'capitalize' }}>{t.category}</span></div>
      </div>
      <div className={`amt ${incoming ? 'in' : ''}`}>
        {incoming ? '+' : ''}{money(t.amount, t.currency)}
        <div className="bal">bal {money(t.balanceAfter)}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------- add money / record pay */

export function AddMoney({ ctx, onClose, currency }: { ctx: Ctx; onClose: () => void; currency?: string }) {
  const { home } = ctx.data.profile;
  const [f, setF] = useState({ currency: currency ?? home, amount: '', source: 'Transfer from home bank' });
  const [sources, setSources] = useState<Json[]>([]);
  const [via, setVia] = useState('');
  useEffect(() => { api('/api/linked').then((r) => { setSources(r.sources); if (r.sources[0]) setVia(r.sources[0].id); }).catch(() => {}); }, []);
  const viaSrc = sources.find((s) => s.id === via);
  const providers = useProviders();
  const [how, setHow] = useState<'linked' | 'alipay' | 'stripe'>('linked');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [k] = useState(key);
  async function go(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      if (viaSrc) await api(`/api/linked/${viaSrc.id}/topup`, { method: 'POST', body: JSON.stringify({ amount: f.amount, idempotencyKey: k }) });
      else await api('/api/topup', { method: 'POST', body: JSON.stringify({ ...f, idempotencyKey: k }) });
      await ctx.refresh(); onClose();
    }
    catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  }
  return (
    <Sheet title="Add money" onClose={onClose}>
      {(providers?.alipay || providers?.stripe) && (
        <div className="seg" role="group" aria-label="How" style={{ marginBottom: '1rem' }}>
          <button aria-pressed={how === 'linked'} onClick={() => setHow('linked')}>Linked account</button>
          {providers?.alipay && <button aria-pressed={how === 'alipay'} onClick={() => setHow('alipay')}>Alipay{providers.alipaySandbox ? ' (sandbox)' : ''}</button>}
          {providers?.stripe && <button aria-pressed={how === 'stripe'} onClick={() => setHow('stripe')}>Card · Stripe{providers.stripeTestMode ? ' (test)' : ''}</button>}
        </div>
      )}
      {how === 'alipay' && <AlipayCheckout onError={setErr} />}
      {how === 'stripe' && providers?.stripePublishableKey && (
        <StripeCheckout publishableKey={providers.stripePublishableKey} currency={ctx.data.profile.study}
          onDone={async () => { await ctx.refresh(); onClose(); }} onError={setErr} />
      )}
      {how !== 'linked' && err && <div className="notice error" role="alert" style={{ marginTop: '.75rem' }}>{err}</div>}
      {how === 'linked' && <form className="stack" onSubmit={go}>
        <div><label htmlFor="am-v">From</label>
          <select id="am-v" value={via} onChange={(e) => setVia(e.target.value)}>
            {sources.map((s) => <option key={s.id} value={s.id}>{s.label} ({s.currency})</option>)}
            <option value="">Test funds (no linked account)</option>
          </select>
          {sources.length === 0 && <p className="hint">Link a card, Alipay, WeChat Pay or bank in Cards &amp; accounts to add money from it.</p>}</div>
        <div><label htmlFor="am-a">Amount</label>
          <div className="pair"><input id="am-a" inputMode="decimal" autoFocus value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="10000.00" required />
            {viaSrc ? <span className="tag" style={{ alignSelf: 'center' }}>{viaSrc.currency}</span>
              : <select aria-label="Currency" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select>}</div></div>
        {err && <div className="notice error" role="alert">{err}</div>}
        <button className="btn" disabled={busy} style={{ justifyContent: 'center' }}>{busy ? 'Adding…' : 'Add money'}</button>
      </form>}
    </Sheet>
  );
}

export function RecordPayment({ ctx, onClose }: { ctx: Ctx; onClose: () => void }) {
  const { study } = ctx.data.profile;
  const [f, setF] = useState({ currency: study, amount: '', merchant: '', category: 'food' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [k] = useState(key);
  async function go(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await api('/api/spend', { method: 'POST', body: JSON.stringify({ ...f, idempotencyKey: k }) }); await ctx.refresh(); onClose(); }
    catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  }
  return (
    <Sheet title="Pay with BridgeWise" onClose={onClose}>
      <form className="stack" onSubmit={go}>
        <div><label htmlFor="rp-m">Where</label><input id="rp-m" autoFocus value={f.merchant} onChange={(e) => setF({ ...f, merchant: e.target.value })} placeholder="Tesco, TfL, landlord…" required /></div>
        <div className="field-row">
          <div><label htmlFor="rp-a">Amount</label>
            <div className="pair"><input id="rp-a" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="24.50" required />
              <select aria-label="Pocket" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>{(ctx.data.wallet.pockets as Json[]).map((p) => <option key={p.currency}>{p.currency}</option>)}</select></div></div>
          <div><label htmlFor="rp-c">Category</label>
            <select id="rp-c" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{CATS.map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
        </div>
        {err && <div className="notice error" role="alert">{err}</div>}
        <button className="btn" disabled={busy} style={{ justifyContent: 'center' }}>{busy ? 'Paying…' : 'Pay'}</button>
      </form>
    </Sheet>
  );
}

/* ---------------------------------------------------------------- activity */

export function Activity(ctx: Ctx) {
  const pockets = ctx.data.wallet.pockets as Json[];
  const [cur, setCur] = useState<string>('');
  const [cat, setCat] = useState<string>('');
  const [rows, setRows] = useState<Json[] | null>(null);
  const load = useCallback(async () => {
    const q = new URLSearchParams({ limit: '200', ...(cur ? { currency: cur } : {}), ...(cat ? { category: cat } : {}) });
    setRows((await api(`/api/transactions?${q}`)).transactions);
  }, [cur, cat]);
  useEffect(() => { load().catch(() => setRows([])); }, [load, ctx.data]);

  return (
    <section className="card">
      <div className="card-head wrap">
        <div className="seg" role="group" aria-label="Pocket">
          <button aria-pressed={cur === ''} onClick={() => setCur('')}>All</button>
          {pockets.map((p) => <button key={p.currency} aria-pressed={cur === p.currency} onClick={() => setCur(p.currency)}>{p.currency}</button>)}
        </div>
        <select aria-label="Category" value={cat} onChange={(e) => setCat(e.target.value)} style={{ width: 170 }}>
          <option value="">All categories</option>{[...CATS, 'fx', 'income'].map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      {rows === null && <p className="muted small">Loading…</p>}
      {rows?.length === 0 && <p className="muted small">No transactions match.</p>}
      {rows?.map((t) => <TxRow key={t.id} t={t} />)}
    </section>
  );
}

/* -------------------------------------------------------------------- send */

export function SendMoney(ctx: Ctx) {
  const { home } = ctx.data.profile;
  const [list, setList] = useState<Json[]>([]);
  const [adding, setAdding] = useState(false);
  const [nr, setNr] = useState({ name: '', relationship: 'friend', country: 'CN', currency: 'CNY', alipayAccount: '', alipayName: '' });
  const [sel, setSel] = useState<string>('');
  const [amt, setAmt] = useState('');
  const [from, setFrom] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lastId, setLastId] = useState<string | null>(null);
  const loadR = useCallback(async () => { const r = (await api('/api/recipients')).recipients; setList(r); if (!sel && r[0]) setSel(r[0].id); }, [sel]);
  useEffect(() => { loadR().catch(() => {}); }, [loadR]);

  async function addR(e: React.FormEvent) {
    e.preventDefault(); setErr(null);
    try { const r = await api('/api/recipients', { method: 'POST', body: JSON.stringify(nr) }); setAdding(false); setSel(r.recipient.id); await loadR(); }
    catch (x: any) { setErr(x.message); }
  }
  async function quote(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { const p = await api('/api/send', { method: 'POST', body: JSON.stringify({ recipientId: sel, receiveAmount: amt, ...(from ? { fromCurrency: from } : {}) }) }); setLastId(p.id); await ctx.refresh(); }
    catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  }
  const r = list.find((x) => x.id === sel);
  const card = (ctx.data.proposals as Json[]).find((p) => p.id === lastId);

  return (
    <>
      <section className="card">
        <div className="card-head"><h2>Send to a person</h2><button className="btn secondary small" onClick={() => setAdding((a) => !a)}><Icon name="send" size={14} /> {adding ? 'Cancel' : 'New recipient'}</button></div>
        {adding && (
          <form className="stack" onSubmit={addR} style={{ marginBottom: '1rem', paddingBottom: '1rem', borderBottom: '1px solid var(--line)' }}>
            <div className="field-row">
              <div><label htmlFor="r-n">Name</label><input id="r-n" value={nr.name} onChange={(e) => setNr({ ...nr, name: e.target.value })} placeholder="Mum" required /></div>
              <div><label htmlFor="r-rel">Relationship</label><select id="r-rel" value={nr.relationship} onChange={(e) => setNr({ ...nr, relationship: e.target.value })}>{['family', 'friend', 'landlord', 'university', 'other'].map((x) => <option key={x}>{x}</option>)}</select></div>
              <div><label htmlFor="r-a">Their Alipay account</label><input id="r-a" value={nr.alipayAccount} onChange={(e) => setNr({ ...nr, alipayAccount: e.target.value })} placeholder="Mobile number or email" autoComplete="off" required /></div>
              <div><label htmlFor="r-rn">Real name on that Alipay</label><input id="r-rn" value={nr.alipayName} onChange={(e) => setNr({ ...nr, alipayName: e.target.value })} placeholder="李娜" autoComplete="off" required /></div>
            </div>
            <p className="hint">Money goes straight into their Alipay, in CNY; Alipay checks the real name before paying. Only you can add recipients, so no message or invoice can make the assistant pay a new account. Transfers to banks and wallets in Pakistan aren’t available yet.</p>
            <div><button className="btn small">Save recipient</button></div>
          </form>
        )}
        {list.length === 0 && !adding && <p className="muted small">No recipients yet. Add the people you send money to.</p>}
        {list.length > 0 && (
          <form className="field-row" onSubmit={quote} style={{ alignItems: 'end' }}>
            <div><label htmlFor="s-r">To</label><select id="s-r" value={sel} onChange={(e) => setSel(e.target.value)}>{list.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.accountLabel}</option>)}</select></div>
            <div><label htmlFor="s-amt">They receive ({r?.currency})</label><input id="s-amt" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="2000.00" required /></div>
            <div><label htmlFor="s-from">Pay from</label><select id="s-from" value={from} onChange={(e) => setFrom(e.target.value)}><option value="">Best pocket</option>{(ctx.data.wallet.pockets as Json[]).map((p) => <option key={p.currency}>{p.currency}</option>)}</select></div>
            <div><button className="btn" disabled={busy || !sel} style={{ width: '100%', justifyContent: 'center' }}>{busy ? 'Quoting…' : 'Get quote'}</button></div>
          </form>
        )}
        {err && <div className="notice error" role="alert" style={{ marginTop: '.75rem' }}>{err}</div>}
        {card && <div style={{ marginTop: '1rem' }}><ApprovalCard p={card} onApprove={ctx.approve} onDecline={ctx.decline} busy={ctx.approving === card.id} /></div>}
      </section>
      <h2 style={{ fontSize: '1.02rem', marginTop: '.5rem' }}>Paying a big bill? See what the market charges</h2>
      <CompareProviders {...ctx} />
    </>
  );
}

/* ------------------------------------------------------------------ budget */

export function Budget(ctx: Ctx) {
  const { study } = ctx.data.profile;
  const [s, setS] = useState<Json | null>(null);
  const [b, setB] = useState<Json[]>([]);
  const [f, setF] = useState({ category: 'food', monthlyLimit: '' });
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    const [sum, bud] = await Promise.all([api('/api/spending?days=30'), api('/api/budgets')]);
    setS(sum); setB(bud.budgets);
  }, []);
  useEffect(() => { load().catch((x) => setErr(x.message)); }, [load, ctx.data]);

  async function save(e: React.FormEvent) {
    e.preventDefault(); setErr(null);
    try { setB((await api('/api/budgets', { method: 'POST', body: JSON.stringify({ ...f, currency: study }) })).budgets); setF({ ...f, monthlyLimit: '' }); }
    catch (x: any) { setErr(x.message); }
  }

  return (
    <>
      <div className="grid-3">
        <div className="card stat"><span className="k">Spent, last 30 days</span><span className="v">{s ? money(s.total, s.display) : '…'}</span></div>
        <div className="card stat"><span className="k">Average per day</span><span className="v">{s ? money(s.averageDaily, s.display) : '…'}</span></div>
        <div className="card stat"><span className="k">Your money lasts</span><span className="v">{s?.runwayDays != null ? `${s.runwayDays} days` : '—'}</span><span className="faint small">at this pace, excluding tuition</span></div>
      </div>
      <div className="grid-2">
        <section className="card">
          <div className="card-head"><h2>Where it went</h2><button className="btn secondary small" onClick={() => ctx.ask('How much did I spend this month, and where can I cut back?')}><Icon name="spark" size={14} /> Ask for advice</button></div>
          {s && s.categories.length > 0
            ? <Donut items={s.categories.map((c: Json) => ({ label: c.category, value: Number(c.amount) }))} center={<div><div className="faint small">30 days</div><strong>{money(s.total)}</strong></div>} />
            : <p className="muted small">No spending yet. Pay with BridgeWise and it appears here.</p>}
        </section>
        <section className="card">
          <div className="card-head"><h2>Monthly budgets</h2></div>
          {b.length === 0 && <p className="muted small">No budgets yet.</p>}
          {b.map((x) => (
            <div key={x.category} style={{ padding: '.55rem 0' }}>
              <div className="row between small"><span style={{ textTransform: 'capitalize', fontWeight: 600 }}>{CATEGORY_ICON[x.category]} {x.category}</span>
                <span className="num">{money(x.spent)} / {money(x.limit, x.currency)}</span></div>
              <div className={`bar ${x.over ? 'over' : ''}`} style={{ marginTop: '.35rem' }}><span style={{ width: `${Math.min(100, x.percent)}%` }} /></div>
              {x.over && <div className="small" style={{ color: 'var(--bad)', marginTop: '.2rem' }}>Over by {money(String(x.remaining).replace('-', ''), x.currency)}</div>}
            </div>
          ))}
          <form className="row wrap" onSubmit={save} style={{ marginTop: '.8rem' }}>
            <select aria-label="Category" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} style={{ width: 140 }}>{CATS.map((c) => <option key={c}>{c}</option>)}</select>
            <input aria-label={`Monthly limit in ${study}`} inputMode="decimal" value={f.monthlyLimit} onChange={(e) => setF({ ...f, monthlyLimit: e.target.value })} placeholder={`Limit in ${study}`} style={{ width: 150 }} />
            <button className="btn small" disabled={!f.monthlyLimit}>Set budget</button>
          </form>
          {err && <div className="notice error" role="alert" style={{ marginTop: '.6rem' }}>{err}</div>}
        </section>
      </div>
    </>
  );
}

export { CcyBadge };
