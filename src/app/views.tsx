'use client';

import { useEffect, useState } from 'react';
import { ApprovalCard, CcyBadge, Icon, Sparkline, money, type Json } from './ui';
import { TxRow } from './views2';

export const CURRENCIES = ['GBP', 'USD', 'EUR', 'CNY', 'PKR', 'INR', 'AUD', 'CAD', 'JPY', 'KRW', 'AED'];

export async function api(path: string, init?: RequestInit): Promise<Json> {
  const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.message ?? `Request failed (${res.status})`), { status: res.status, body });
  return body;
}

export interface Ctx {
  data: Json;
  refresh: () => Promise<void>;
  ask: (text: string) => void;
  approve: (p: Json) => void;
  decline: (p: Json) => void;
  approving: string | null;
  go: (tab: string) => void;
  sheet: (which: 'add' | 'pay', how?: 'alipay' | 'stripe') => void;
}

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/* ------------------------------------------------------------- onboarding */

const PERSONAS = [
  { id: 'pk-cn', label: 'From Pakistan, studying in China', home: 'PKR', study: 'CNY', },
  { id: 'in-cn', label: 'From India, studying in China', home: 'INR', study: 'CNY', },
  { id: 'cn-uk', label: 'From China, studying in the UK', home: 'CNY', study: 'GBP', },
  { id: 'pk-us', label: 'From Pakistan, studying in the US', home: 'PKR', study: 'USD', },
];

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'signup' | 'signin'>('signup');
  const [form, setForm] = useState({ name: '', email: '', password: '', homeCurrency: 'PKR', studyCurrency: 'CNY', });
  const [persona, setPersona] = useState('pk-cn');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = mode === 'signup'
        ? await api('/api/auth/signup', { method: 'POST', body: JSON.stringify({ ...form, name: form.name.trim() || 'Student' }) })
        : await api('/api/auth/signin', { method: 'POST', body: JSON.stringify({ email: form.email, password: form.password }) });
      try { localStorage.setItem('bw-name', r.name ?? form.name); } catch { /* private mode */ }
      onDone();
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <div className="onboard">
      <section className="onboard-hero">
        <div className="logo" style={{ padding: 0 }}><span className="logo-mark">BW</span> BridgeWise</div>
        <h1>Your money, across borders, handled.</h1>
        <p>One account for every currency you live in — linked to Alipay, WeChat Pay, your bank cards and your bank back home. An AI assistant that reads your tuition invoices, watches exchange rates, builds your credit in China and prepares every payment — and never moves money without your approval.</p>
        <div className="features">
          {[
            ['wallet', 'CNY, PKR, INR, GBP, USD and more — valued at live ECB rates'],
            ['card', 'Link Alipay 支付宝, WeChat Pay 微信支付, UnionPay and Visa cards, CCB, ICBC and BOC'],
            ['bill', 'Paste a tuition invoice; the assistant sets up the payment and protects your living money'],
            ['shield', 'Every action is a card you approve. The assistant cannot execute anything.'],
          ].map(([i, t]) => (
            <div className="feature" key={t}><span><Icon name={i!} size={15} /></span><span>{t}</span></div>
          ))}
        </div>
      </section>
      <section className="onboard-form">
        <form className="card stack" onSubmit={submit}>
          <div className="seg" role="group" aria-label="Account">
            <button type="button" aria-pressed={mode === 'signup'} onClick={() => setMode('signup')}>Create account</button>
            <button type="button" aria-pressed={mode === 'signin'} onClick={() => setMode('signin')}>Sign in</button>
          </div>
          <div><label htmlFor="em">Email</label><input id="em" type="email" autoComplete="email" value={form.email} onChange={(e) => set('email', e.target.value)} required /></div>
          <div><label htmlFor="pw">Password</label><input id="pw" type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} value={form.password} onChange={(e) => set('password', e.target.value)} required />
            {mode === 'signup' && <p className="hint">At least 8 characters, with letters and a number.</p>}</div>
          {mode === 'signup' && (
            <>
              <div><label htmlFor="nm">Your first name</label><input id="nm" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Ali" autoComplete="given-name" /></div>
              <div className="stack" style={{ gap: '.45rem' }}>
                {PERSONAS.map((p) => (
                  <button type="button" key={p.id} className="persona" aria-pressed={persona === p.id}
                    onClick={() => { setPersona(p.id); setForm((f) => ({ ...f, homeCurrency: p.home, studyCurrency: p.study })); }}>
                    <span className="row" style={{ gap: '.5rem' }}><CcyBadge ccy={p.home} /> → <CcyBadge ccy={p.study} /> <span>{p.label}</span></span>
                  </button>
                ))}
              </div>
              <div className="field-row">
                <div>
                  <label htmlFor="hc">Home currency</label>
                  <div className="pair">
                    <select id="hc" value={form.homeCurrency} onChange={(e) => set('homeCurrency', e.target.value)}>
                      {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
                    </select>
                  </div>
                </div>
                <div>
                  <label htmlFor="sc">Currency where you study</label>
                  <div className="pair">
                    <select id="sc" value={form.studyCurrency} onChange={(e) => set('studyCurrency', e.target.value)}>
                      {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
                    </select>
                  </div>
                </div>
              </div>
            </>
          )}
          {error && <div className="notice error" role="alert">{error}</div>}
          <button className="btn" disabled={busy} style={{ justifyContent: 'center' }}>
            {busy ? 'Please wait…' : mode === 'signup' ? 'Create my account' : 'Sign in'}
          </button>
          <p className="faint small">Your wallet starts empty. Add money with Alipay or a bank card.</p>
        </form>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------- home */

export function Home({ data, ask, approve, decline, approving, go, sheet }: Ctx) {
  const w = data.wallet;
  const pending = (data.proposals as Json[]).filter((p) => p.status === 'PENDING');
  const bills = (data.bills as Json[]).filter((b) => !b.paid).sort((a, b) => a.daysLeft - b.daysLeft);
  const sevIcon: Record<string, string> = { urgent: 'alert', attention: 'clock', good: 'check', info: 'spark' };

  return (
    <>
      <div className="grid-2 wide-left">
        <section className="card balance-hero">
          <div className="label">Total across your pockets</div>
          <div className="big num">{money(w.totalInDisplay, w.displayCurrency)}</div>
          <div className="sub">Indicative · live rates from {w.rates?.source ?? 'market data'}</div>
          <div className="actions">
            <button className="btn ghost small" onClick={() => sheet('add')}><Icon name="down" size={14} /> Add money</button>
            <button className="btn ghost small" onClick={() => go('send')}><Icon name="send" size={14} /> Send</button>
            <button className="btn ghost small" onClick={() => go('wallet')}><Icon name="swap" size={14} /> Convert</button>
            <button className="btn ghost small" onClick={() => sheet('pay')}><Icon name="card" size={14} /> Log expense</button>
            <button className="btn ghost small" onClick={() => go('bills')}><Icon name="bill" size={14} /> Bills</button>
          </div>
        </section>
        <section className="card">
          <div className="card-head"><h2>Pockets</h2><button className="btn secondary small" onClick={() => go('wallet')}>Manage</button></div>
          <div className="stack" style={{ gap: '.55rem' }}>
            {(w.pockets as Json[]).map((p) => (
              <div key={p.id} className="row between">
                <span className="row" style={{ gap: '.55rem' }}><CcyBadge ccy={p.currency} /><span>{p.currency}</span></span>
                <span style={{ textAlign: 'right' }}>
                  <strong className="num">{money(p.balance)}</strong>
                  {p.currency !== w.displayCurrency && p.valueInDisplay && <div className="faint small num">≈ {money(p.valueInDisplay, w.displayCurrency)}</div>}
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="card">
        <div className="card-head">
          <h2 className="row" style={{ gap: '.45rem' }}><Icon name="spark" /> BridgeWise noticed</h2>
          <span className="faint small">Updated just now</span>
        </div>
        {(data.insights as Json[]).map((i) => (
          <div key={i.id} className={`insight ${i.severity}`}>
            <span className="dot"><Icon name={sevIcon[i.severity] ?? 'spark'} size={16} /></span>
            <div><h3>{i.title}</h3><p>{i.body}</p></div>
            {i.ask && <button className="btn secondary small" onClick={() => ask(i.ask)}>{i.askLabel ?? 'Ask'}</button>}
          </div>
        ))}
      </section>

      {pending.length > 0 && (
        <section className="stack">
          <h2 style={{ fontSize: '1.02rem' }}>Waiting for your approval</h2>
          {pending.map((p) => <ApprovalCard key={p.id} p={p} onApprove={approve} onDecline={decline} busy={approving === p.id} />)}
        </section>
      )}

      <div className="grid-2">
        <section className="card">
          <div className="card-head"><h2>Upcoming bills</h2><button className="btn secondary small" onClick={() => go('bills')}>Add bill</button></div>
          {bills.length === 0 && <p className="muted small">{(data.bills as Json[]).length ? 'Nothing due — every bill is paid.' : 'No bills yet. Paste your tuition invoice into the assistant and it will set up the payment.'}</p>}
          {bills.slice(0, 4).map((b) => (
            <div key={b.id} className="list-row">
              <span className="icon-tile"><Icon name="bill" /></span>
              <div className="grow"><div className="title">{b.description}</div><div className="faint small">Due {fmtDate(b.dueAt)}</div></div>
              <div style={{ textAlign: 'right' }}>
                <strong className="num">{money(b.amount, b.currency)}</strong>
                <div><span className={`tag ${b.daysLeft <= 14 ? 'bad' : b.daysLeft <= 30 ? 'warn' : ''}`}>{b.daysLeft} days</span></div>
              </div>
            </div>
          ))}
        </section>
        <section className="card">
          <div className="card-head"><h2>Recent transactions</h2><button className="btn secondary small" onClick={() => go('activity')}>See all</button></div>
          {(data.transactions as Json[]).length === 0 && <p className="muted small">Nothing yet.</p>}
          {(data.transactions as Json[]).slice(0, 6).map((t) => <TxRow key={t.id} t={t} />)}
        </section>
      </div>
    </>
  );
}

/* ----------------------------------------------------------------- wallet */

export function Wallet({ data, refresh, approve, decline, approving, sheet, go }: Ctx) {
  const w = data.wallet;
  const { home, study } = data.profile;
  const [form, setForm] = useState({ from: home, to: study, sellAmount: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastId, setLastId] = useState<string | null>(null);

  async function quote(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const p = await api('/api/proposals', { method: 'POST', body: JSON.stringify(form) });
      setLastId(p.id);
      await refresh();
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  }
  const card = (data.proposals as Json[]).find((p) => p.id === lastId);

  return (
    <>
      <div className="actions">
        <button className="btn" onClick={() => sheet('add')}><Icon name="down" size={15} /> Add money</button>
        <button className="btn secondary" onClick={() => sheet('pay')}><Icon name="card" size={15} /> Log expense</button>
        <button className="btn secondary" onClick={() => go('send')}><Icon name="send" size={15} /> Send</button>
        <button className="btn secondary" onClick={() => go('activity')}><Icon name="clock" size={15} /> Statement</button>
      </div>
      <div className="grid-3">
        {(w.pockets as Json[]).map((p) => (
          <div key={p.id} className="pocket">
            <div className="ccy"><CcyBadge ccy={p.currency} /> {p.currency} pocket</div>
            <div className="amt">{money(p.balance)}</div>
            <div className="val">{p.currency === w.displayCurrency ? 'Display currency' : p.valueInDisplay ? `≈ ${money(p.valueInDisplay, w.displayCurrency)}` : 'Rate unavailable'}</div>
          </div>
        ))}
      </div>

      <section className="card">
        <div className="card-head"><h2>Convert between pockets</h2><span className="tag">Live rate · 0.30% fee, shown up front</span></div>
        <form className="field-row" onSubmit={quote} style={{ alignItems: 'end' }}>
          <div><label htmlFor="cf">From</label>
            <select id="cf" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })}>
              {(w.pockets as Json[]).map((p) => <option key={p.currency}>{p.currency}</option>)}
            </select></div>
          <div><label htmlFor="ct">To</label>
            <select id="ct" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })}>
              {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
            </select></div>
          <div><label htmlFor="ca">Amount to sell ({form.from})</label>
            <input id="ca" inputMode="decimal" value={form.sellAmount} onChange={(e) => setForm({ ...form, sellAmount: e.target.value })} placeholder="5000.00" required /></div>
          <div><button className="btn" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>{busy ? 'Getting quote…' : 'Get quote'}</button></div>
        </form>
        {error && <div className="notice error" role="alert" style={{ marginTop: '.75rem' }}>{error}</div>}
        {card && <div style={{ marginTop: '1rem' }}><ApprovalCard p={card} onApprove={approve} onDecline={decline} busy={approving === card.id} /></div>}
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ bills */

export function Bills({ data, refresh, ask, approve, decline, approving }: Ctx) {
  const { home, study } = data.profile;
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<Json | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function read() {
    setBusy('read'); setError(null);
    try {
      const x = await api('/api/bills/parse', { method: 'POST', body: JSON.stringify({ text }) });
      setDraft({ description: 'Tuition', amount: x.amount ?? '', currency: x.currency ?? study, payee: x.payee ?? '', reference: x.reference ?? '', dueDate: x.dueDate ?? '', dueTime: '17:00', reserve: '', alipayAccount: '', alipayName: '', missing: x.missing });
    } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  }
  async function save() {
    setBusy('save'); setError(null);
    try {
      const { missing, ...body } = draft!;
      void missing;
      const made = await api('/api/bills', { method: 'POST', body: JSON.stringify({ ...body, reserve: body.reserve || undefined, alipayAccount: body.alipayAccount || undefined, alipayName: body.alipayName || undefined, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }) });
      await api(`/api/bills/${made.billId}/pay`, { method: 'POST', body: '{}' }).catch((e) => setError(`Saved. ${e.message}`));
      setDraft(null); setText('');
      await refresh();
    } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  }
  async function markPaid(id: string) {
    setBusy(id); setError(null);
    try { await api(`/api/bills/${id}/paid`, { method: 'POST', body: '{}' }); await refresh(); }
    catch (e: any) { setError(e.message); } finally { setBusy(null); }
  }
  async function pay(id: string) {
    setBusy(id); setError(null);
    try { await api(`/api/bills/${id}/pay`, { method: 'POST', body: '{}' }); await refresh(); }
    catch (e: any) { setError(e.message); } finally { setBusy(null); }
  }

  const pending = (data.proposals as Json[]).filter((p) => p.kind === 'pay_bill' && p.status === 'PENDING');
  const bills = (data.bills as Json[]).sort((a, b) => a.daysLeft - b.daysLeft);
  const d = draft;

  return (
    <>
      <section className="card stack">
        <div className="card-head" style={{ marginBottom: 0 }}><h2>Add a bill from your invoice</h2><span className="tag brand">Read by parser, checked by you</span></div>
        <label htmlFor="inv" className="skip">Invoice text</label>
        <textarea id="inv" value={text} onChange={(e) => setText(e.target.value)}
          placeholder={'Paste the text of your tuition invoice — e.g.\n\nKing’s College London · Student ID: K2104471\nAmount due: GBP 9,250.00 · Payment due by 15 November 2026'} />
        <div className="actions">
          <button className="btn" disabled={!text.trim() || !!busy} onClick={read}>{busy === 'read' ? 'Reading…' : 'Read invoice'}</button>
          <button className="btn secondary" disabled={!text.trim() || !!busy} onClick={() => ask(text)}><Icon name="spark" size={15} /> Let the assistant handle it</button>
        </div>
        {d && (
          <div className="stack" style={{ borderTop: '1px solid var(--line)', paddingTop: '1rem' }}>
            <h3 style={{ fontSize: '.95rem' }}>Check what we read</h3>
            {d.missing?.length > 0 && <div className="notice info">Couldn&rsquo;t find: {d.missing.join(', ')} — please fill in.</div>}
            <div className="field-row">
              <div><label htmlFor="b-a">Amount</label>
                <div className="pair"><input id="b-a" value={d.amount} onChange={(e) => setDraft({ ...d, amount: e.target.value })} />
                  <select aria-label="Bill currency" value={d.currency} onChange={(e) => setDraft({ ...d, currency: e.target.value })}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select></div></div>
              <div><label htmlFor="b-p">Pay to</label><input id="b-p" value={d.payee} onChange={(e) => setDraft({ ...d, payee: e.target.value })} /></div>
              <div><label htmlFor="b-r">Reference</label><input id="b-r" value={d.reference} onChange={(e) => setDraft({ ...d, reference: e.target.value })} /></div>
              <div><label htmlFor="b-d">Due</label><input id="b-d" type="date" value={d.dueDate} onChange={(e) => setDraft({ ...d, dueDate: e.target.value })} /></div>
              <div><label htmlFor="b-k">Keep at least ({home})</label><input id="b-k" inputMode="decimal" value={d.reserve} onChange={(e) => setDraft({ ...d, reserve: e.target.value })} placeholder="e.g. 10000" />
                <p className="hint">We&rsquo;ll refuse any payment that leaves you less to live on.</p></div>
              <div><label htmlFor="b-al">Payee&rsquo;s Alipay (optional)</label><input id="b-al" value={d.alipayAccount} onChange={(e) => setDraft({ ...d, alipayAccount: e.target.value })} placeholder="Mobile number or email" autoComplete="off" /></div>
              <div><label htmlFor="b-an">Real name on that Alipay</label><input id="b-an" value={d.alipayName} onChange={(e) => setDraft({ ...d, alipayName: e.target.value })} autoComplete="off" /></div>
            </div>
            <p className="hint">With the payee&rsquo;s Alipay, BridgeWise pays the bill straight into it in CNY. Without it, approving sets the money aside so it can&rsquo;t be spent, and you pay through the payee&rsquo;s own portal.</p>
            <div className="actions"><button className="btn" disabled={!!busy} onClick={save}>{busy === 'save' ? 'Saving…' : 'Save and prepare payment'}</button>
              <button className="btn secondary" onClick={() => setDraft(null)}>Cancel</button></div>
          </div>
        )}
        {error && <div className="notice error" role="alert">{error}</div>}
      </section>

      {pending.map((p) => <ApprovalCard key={p.id} p={p} onApprove={approve} onDecline={decline} busy={approving === p.id} />)}

      <section className="card">
        <div className="card-head"><h2>Your bills</h2></div>
        {bills.length === 0 && <p className="muted small">No bills yet.</p>}
        {bills.map((b) => (
          <div key={b.id} className="list-row">
            <span className="icon-tile"><Icon name="bill" /></span>
            <div className="grow"><div className="title">{b.description}</div><div className="faint small">Due {fmtDate(b.dueAt)}</div></div>
            <strong className="num">{money(b.amount, b.currency)}</strong>
            {b.paid ? <span className="tag ok">Paid</span>
              : b.setAside ? <><span className="tag brand">Set aside</span><button className="btn secondary small" disabled={busy === b.id} onClick={() => markPaid(b.id)}>{busy === b.id ? '…' : 'Mark as paid'}</button></>
              : <button className="btn small" disabled={busy === b.id} onClick={() => pay(b.id)}>{busy === b.id ? '…' : 'Pay'}</button>}
          </div>
        ))}
      </section>
    </>
  );
}

/* ------------------------------------------------------------------- send */

export function Send({ data }: Ctx) {
  const { home, study } = data.profile;
  const homePocket = (data.wallet.pockets as Json[]).find((p) => p.currency === home);
  const due = new Date(Date.now() + 21 * 864e5).toISOString().slice(0, 10);
  const [form, setForm] = useState({ targetAmount: '2000.00', targetCurrency: study, sourceCurrency: home, balance: homePocket?.balance ?? '0', reserve: '0', deadlineDate: due, deadlineTime: '17:00', deadlineTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  const [r, setR] = useState<Json | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function run(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true); setError(null);
    try { setR(await api('/api/quote', { method: 'POST', body: JSON.stringify(form) })); }
    catch (err: any) { setError(err.message); } finally { setBusy(false); }
  }
  const rows: Json[] = r ? [...(r.best ? [{ ...r.best, best: true }] : []), ...r.alternatives, ...r.rejected] : [];

  return (
    <>
      <section className="card">
        <div className="card-head"><h2>Compare real providers</h2><span className="tag ok">Live quotes</span></div>
        <form className="field-row" onSubmit={run} style={{ alignItems: 'end' }}>
          <div><label htmlFor="s-a">They should receive</label>
            <div className="pair"><input id="s-a" inputMode="decimal" value={form.targetAmount} onChange={(e) => set('targetAmount', e.target.value)} />
              <select aria-label="Receive currency" value={form.targetCurrency} onChange={(e) => set('targetCurrency', e.target.value)}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select></div></div>
          <div><label htmlFor="s-f">You pay in</label>
            <select id="s-f" value={form.sourceCurrency} onChange={(e) => set('sourceCurrency', e.target.value)}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select></div>
          <div><label htmlFor="s-d">Must arrive by</label><input id="s-d" type="date" value={form.deadlineDate} onChange={(e) => set('deadlineDate', e.target.value)} /></div>
          <div><button className="btn" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>{busy ? 'Checking 17 providers…' : 'Compare'}</button></div>
        </form>
        {error && <div className="notice error" role="alert" style={{ marginTop: '.75rem' }}>{error}</div>}
      </section>

      {r?.best && (
        <section className="card">
          <p className="faint small" style={{ textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 700 }}>Cheapest that arrives in time</p>
          <div className="row between wrap" style={{ marginTop: '.3rem' }}>
            <h2 style={{ fontSize: '1.5rem' }}>{r.best.provider}</h2>
            <div style={{ textAlign: 'right' }}><div className="faint small">You send</div><strong className="num" style={{ fontSize: '1.5rem' }}>{money(r.best.youSend, form.sourceCurrency)}</strong></div>
          </div>
          {r.costOfChoosingWorst && <div className="notice ok" style={{ marginTop: '.75rem' }}>Choosing the worst usable option would cost <strong>{money(r.costOfChoosingWorst, form.sourceCurrency)}</strong> more for the same transfer.</div>}
          <p className="small muted" style={{ marginTop: '.6rem' }}>Fee {money(r.best.fee, form.sourceCurrency)} · {r.best.hiddenMarginPercent}% hidden in the exchange rate · arrival {r.best.arrival}</p>
        </section>
      )}

      {rows.length > 0 && (
        <section className="card">
          <div className="table-scroll">
            <table>
              <thead><tr><th>Provider</th><th className="r">You send</th><th className="r">Fee</th><th className="r">Rate margin</th><th>Arrival</th><th>Verdict</th></tr></thead>
              <tbody>
                {rows.map((q, i) => (
                  <tr key={i} className={q.usable ? '' : 'dim'}>
                    <th scope="row">{q.provider} {q.best && <span className="tag ok">Best</span>}<div className="faint small" style={{ fontWeight: 400 }}>{q.providerType === 'bank' ? 'Bank' : 'Transfer provider'}</div></th>
                    <td className="r">{money(q.youSend)}</td><td className="r">{money(q.fee)}</td><td className="r">{q.hiddenMarginPercent}%</td>
                    <td className="small">{q.arrival}</td>
                    <td>{q.usable ? <span className="tag ok">Usable</span> : <span className="tag bad">{q.problems?.includes('MISSES_DEADLINE') ? 'Too slow' : q.problems?.includes('BREACHES_RESERVE') ? 'Eats reserve' : q.problems?.includes('INSUFFICIENT_BALANCE') ? 'Over balance' : 'Not usable'}</span>}</td>
                  </tr>
                ))}
              </tbody>
              <caption>{r!.providerData.count} live quotes · {r!.providerData.source} · reference rate {r!.referenceRate.mid} ({r!.referenceRate.source}). {r!.providerData.disclosure} {r!.providerData.note ?? ''}</caption>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- markets */

export function Markets({ data, ask }: Ctx) {
  const { home, study } = data.profile;
  const pairs: Array<[string, string]> = [[home, study], [study, 'USD'], [home, 'USD'], ['EUR', study]].filter(
    ([a, b], i, all) => a !== b && all.findIndex(([x, y]) => x === a && y === b) === i,
  ) as Array<[string, string]>;
  const [rows, setRows] = useState<Record<string, Json>>({});
  const [sel, setSel] = useState(`${home}/${study}`);
  const [level, setLevel] = useState('');

  useEffect(() => {
    pairs.forEach(([a, b]) => {
      api(`/api/fx?base=${a}&quote=${b}&days=30`).then((r) => setRows((m) => ({ ...m, [`${a}/${b}`]: r }))).catch(() => setRows((m) => ({ ...m, [`${a}/${b}`]: { error: true } })));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [home, study]);

  const cur = rows[sel];
  const [base, quote] = sel.split('/');

  return (
    <>
      <section className="card">
        <div className="card-head">
          <div><h2>{sel}</h2><p className="faint small">Daily ECB reference rates · last 30 days</p></div>
          {cur?.live && <div style={{ textAlign: 'right' }}><strong className="num" style={{ fontSize: '1.6rem' }}>{Number(cur.live.mid).toFixed(5)}</strong>
            {cur.history && <div className={`small ${Number(cur.history.changePercent) >= 0 ? '' : ''}`} style={{ color: Number(cur.history.changePercent) >= 0 ? 'var(--ok)' : 'var(--bad)' }}>{Number(cur.history.changePercent) >= 0 ? '+' : ''}{cur.history.changePercent}% in 30 days</div>}</div>}
        </div>
        {cur?.history ? <Sparkline points={cur.history.points} /> : <p className="muted small">{cur?.error ? 'The ECB does not publish this pair; live rate only.' : 'Loading…'}</p>}
        {cur?.history && <p className="faint small" style={{ marginTop: '.5rem' }}>High {cur.history.high.rate} on {cur.history.high.date} · Low {cur.history.low.rate} on {cur.history.low.date} · past movement is not a forecast</p>}
        <form className="row wrap" style={{ marginTop: '1rem' }} onSubmit={(e) => { e.preventDefault(); if (level) ask(`Alert me when ${base}/${quote} goes ${Number(level) >= Number(cur?.live?.mid ?? 0) ? 'above' : 'below'} ${level}`); setLevel(''); }}>
          <label htmlFor="lvl" style={{ margin: 0 }}>Alert me at</label>
          <input id="lvl" inputMode="decimal" value={level} onChange={(e) => setLevel(e.target.value)} placeholder={cur?.live ? Number(cur.live.mid).toFixed(4) : ''} style={{ width: 140 }} />
          <button className="btn secondary small" disabled={!level}><Icon name="bell" size={14} /> Set alert</button>
          <button type="button" className="btn secondary small" onClick={() => ask(`How is the ${base} to ${quote} rate doing?`)}><Icon name="spark" size={14} /> Ask the assistant</button>
        </form>
      </section>

      <section className="card">
        <div className="card-head"><h2>Your currencies</h2></div>
        {pairs.map(([a, b]) => {
          const k = `${a}/${b}`, r = rows[k];
          return (
            <button key={k} className="list-row" onClick={() => setSel(k)} style={{ all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '.85rem', padding: '.7rem 0', borderTop: '1px solid var(--line)', width: '100%' }} aria-pressed={sel === k}>
              <span className="row" style={{ gap: '.3rem' }}><CcyBadge ccy={a} /><CcyBadge ccy={b} /></span>
              <div className="grow" style={{ flex: 1 }}><div className="title">{k}</div><div className="faint small">{r?.live?.source ?? '…'}</div></div>
              {r?.history && <Sparkline points={r.history.points} small />}
              <div style={{ textAlign: 'right', minWidth: 90 }}>
                <strong className="num">{r?.live ? Number(r.live.mid).toFixed(4) : '—'}</strong>
                {r?.history && <div className="small" style={{ color: Number(r.history.changePercent) >= 0 ? 'var(--ok)' : 'var(--bad)' }}>{Number(r.history.changePercent) >= 0 ? '+' : ''}{r.history.changePercent}%</div>}
              </div>
            </button>
          );
        })}
        {(data.alerts as Json[]).length > 0 && (
          <div style={{ marginTop: '1rem' }}>
            <h3 style={{ fontSize: '.9rem', marginBottom: '.4rem' }}>Your alerts</h3>
            {(data.alerts as Json[]).map((a) => (
              <div key={a.id} className="row between small" style={{ padding: '.3rem 0' }}>
                <span><Icon name="bell" size={14} /> {a.pair} {a.direction} {a.threshold}</span>
                <span className={`tag ${a.firedAt ? 'ok' : ''}`}>{a.firedAt ? 'triggered' : 'watching'}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
