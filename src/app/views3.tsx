'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApprovalCard, Icon, money, type Json } from './ui';
import { api, type Ctx } from './views';

const key = () => `ui-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

/** Brand colours for the linked-source tiles. */
const SKIN: Record<string, { bg: string; name: string }> = {
  visa: { bg: 'linear-gradient(135deg,#1a1f71,#2d5bd7)', name: 'VISA' },
  mastercard: { bg: 'linear-gradient(135deg,#1b1b1b,#4a4a4a)', name: 'Mastercard' },
  unionpay: { bg: 'linear-gradient(135deg,#c8102e,#00508f)', name: 'UnionPay 银联' },
  amex: { bg: 'linear-gradient(135deg,#006fcf,#3fa0ff)', name: 'AMEX' },
  jcb: { bg: 'linear-gradient(135deg,#0b4ea2,#0aa04a)', name: 'JCB' },
  alipay: { bg: 'linear-gradient(135deg,#1677ff,#45a2ff)', name: 'Alipay 支付宝' },
  wechatpay: { bg: 'linear-gradient(135deg,#07a854,#2bd47b)', name: 'WeChat Pay 微信支付' },
  ccb: { bg: 'linear-gradient(135deg,#003d8f,#1e6fd0)', name: '中国建设银行 CCB' },
  icbc: { bg: 'linear-gradient(135deg,#b3000f,#e2343f)', name: '中国工商银行 ICBC' },
  boc: { bg: 'linear-gradient(135deg,#a4141c,#d23b3b)', name: '中国银行 BOC' },
  abc: { bg: 'linear-gradient(135deg,#00796b,#26a69a)', name: '中国农业银行 ABC' },
  cmb: { bg: 'linear-gradient(135deg,#a50021,#d6304c)', name: '招商银行 CMB' },
  hsbc_uk: { bg: 'linear-gradient(135deg,#a30000,#db0011)', name: 'HSBC UK' },
  barclays: { bg: 'linear-gradient(135deg,#00395d,#00aeef)', name: 'Barclays' },
  hbl: { bg: 'linear-gradient(135deg,#00664f,#0a9e7a)', name: 'HBL' },
  meezan: { bg: 'linear-gradient(135deg,#5b2a86,#8a4fc0)', name: 'Meezan Bank' },
  chase: { bg: 'linear-gradient(135deg,#0b3c7d,#117aca)', name: 'Chase' },
};

function SourceTile({ s, onTopUp, onOut, onRemove }: { s: Json; onTopUp: () => void; onOut: () => void; onRemove: () => void }) {
  // Cards top up through Stripe, Alipay through Alipay. WeChat Pay and banks have no rail open to us yet.
  const canIn = s.kind === 'card' || s.provider === 'alipay';
  const canOut = s.provider === 'alipay';
  const skin = SKIN[s.provider] ?? { bg: 'linear-gradient(135deg,#334,#556)', name: s.provider };
  return (
    <div className="source">
      <div className="source-face" style={{ background: skin.bg }}>
        <div className="row between"><span className="source-brand">{skin.name}</span><span className="source-kind">{s.kind === 'card' ? 'Card' : s.kind === 'wallet' ? 'Wallet' : 'Bank'}</span></div>
        <div className="source-num">{s.kind === 'card' ? `•••• •••• •••• ${s.last4}` : s.label}</div>
        <div className="row between small"><span>{s.holder ?? ''}</span><span>{s.expiry ?? s.currency}</span></div>
      </div>
      <div className="actions" style={{ marginTop: '.6rem' }}>
        {canIn && <button className="btn small" onClick={onTopUp}><Icon name="down" size={14} /> Add money</button>}
        {canOut && <button className="btn secondary small" onClick={onOut}><Icon name="up" size={14} /> Move out</button>}
        {!canIn && <span className="tag">Payments coming soon</span>}
        <button className="btn danger small" onClick={onRemove} aria-label={`Remove ${s.label}`}>Remove</button>
      </div>
    </div>
  );
}

export function Accounts(ctx: Ctx) {
  const [data, setData] = useState<Json | null>(null);
  const [tab, setTab] = useState<'card' | 'alipay' | 'wechatpay' | 'bank'>('card');
  const [card, setCard] = useState({ number: '', expiry: '', cvc: '', holder: '', currency: ctx.data.profile.study });
  const [wallet, setWallet] = useState({ account: '', holder: '' });
  const [bank, setBank] = useState({ bank: 'ccb', account: '', holder: '' });
  const [action, setAction] = useState<{ id: string; mode: 'in' | 'out'; amount: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [lastId, setLastId] = useState<string | null>(null);

  const load = useCallback(async () => setData(await api('/api/linked')), []);
  useEffect(() => { load().catch((e) => setMsg({ kind: 'error', text: e.message })); }, [load]);

  async function link(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    const body = tab === 'card' ? { kind: 'card', ...card }
      : tab === 'bank' ? { kind: 'bank', ...bank }
      : { kind: 'wallet', provider: tab, ...wallet };
    try {
      const r = await api('/api/linked', { method: 'POST', body: JSON.stringify(body) });
      setMsg({ kind: 'ok', text: `${r.source.label} linked.` });
      setCard({ ...card, number: '', cvc: '' }); setWallet({ account: '', holder: '' }); setBank({ ...bank, account: '' });
      await load();
    } catch (x: any) { setMsg({ kind: 'error', text: x.message }); } finally { setBusy(false); }
  }

  async function act(e: React.FormEvent) {
    e.preventDefault(); if (!action) return; setBusy(true); setMsg(null);
    try {
      if (action.mode === 'in') {
        const r = await api(`/api/linked/${action.id}/topup`, { method: 'POST', body: JSON.stringify({ amount: action.amount, idempotencyKey: key() }) });
        setMsg({ kind: 'ok', text: `Added. New balance ${money(r.balance)}.` });
      } else {
        const p = await api(`/api/linked/${action.id}/withdraw`, { method: 'POST', body: JSON.stringify({ receiveAmount: action.amount }) });
        setLastId(p.id);
      }
      setAction(null);
      await ctx.refresh();
    } catch (x: any) { setMsg({ kind: 'error', text: x.message }); } finally { setBusy(false); }
  }

  async function remove(id: string) {
    try { await api(`/api/linked/${id}`, { method: 'DELETE' }); await load(); } catch (x: any) { setMsg({ kind: 'error', text: x.message }); }
  }

  const sources = (data?.sources as Json[]) ?? [];
  const pending = (ctx.data.proposals as Json[]).find((p) => p.id === lastId);
  const sel = sources.find((s) => s.id === action?.id);

  return (
    <>

      {msg && <div className={`notice ${msg.kind}`} role={msg.kind === 'error' ? 'alert' : 'status'}>{msg.text}</div>}

      <section className="card">
        <div className="card-head"><h2>Linked cards and accounts</h2><span className="faint small">{sources.length} linked</span></div>
        {sources.length === 0 && <p className="muted small">Nothing linked yet. Add a bank card, Alipay, WeChat Pay or a bank account below.</p>}
        <div className="sources">
          {sources.map((s) => (
            <SourceTile key={s.id} s={s}
              onTopUp={() => ctx.sheet('add', s.kind === 'card' ? 'stripe' : 'alipay')}
              onOut={() => setAction({ id: s.id, mode: 'out', amount: '' })}
              onRemove={() => remove(s.id)} />
          ))}
        </div>
        {action && sel && (
          <form className="row wrap" onSubmit={act} style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--line)' }}>
            <strong>{action.mode === 'in' ? `Add money from ${sel.label}` : `Move money to ${sel.label}`}</strong>
            <input aria-label={`Amount in ${sel.currency}`} inputMode="decimal" autoFocus value={action.amount} onChange={(e) => setAction({ ...action, amount: e.target.value })} placeholder={`Amount (${sel.currency})`} style={{ width: 170 }} required />
            <button className="btn small" disabled={busy}>{busy ? '…' : action.mode === 'in' ? 'Add money' : 'Get quote'}</button>
            <button type="button" className="btn secondary small" onClick={() => setAction(null)}>Cancel</button>
          </form>
        )}
        {pending && <div style={{ marginTop: '1rem' }}><ApprovalCard p={pending} onApprove={ctx.approve} onDecline={ctx.decline} busy={ctx.approving === pending.id} /></div>}
      </section>

      <section className="card">
        <div className="card-head"><h2>Link something new</h2></div>
        <div className="seg" role="group" aria-label="Type" style={{ marginBottom: '1rem' }}>
          {([['card', 'Bank card'], ['alipay', 'Alipay'], ['wechatpay', 'WeChat Pay'], ['bank', 'Bank account']] as const).map(([k, l]) => (
            <button key={k} aria-pressed={tab === k} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
        <form className="stack" onSubmit={link}>
          {tab === 'card' && (
            <div className="field-row">
              <div style={{ gridColumn: 'span 2' }}><label htmlFor="c-n">Card number</label><input id="c-n" inputMode="numeric" autoComplete="cc-number" value={card.number} onChange={(e) => setCard({ ...card, number: e.target.value })} placeholder="4242 4242 4242 4242" required /></div>
              <div><label htmlFor="c-e">Expiry</label><input id="c-e" autoComplete="cc-exp" value={card.expiry} onChange={(e) => setCard({ ...card, expiry: e.target.value })} placeholder="MM/YY" required /></div>
              <div><label htmlFor="c-c">Security code</label><input id="c-c" inputMode="numeric" autoComplete="cc-csc" value={card.cvc} onChange={(e) => setCard({ ...card, cvc: e.target.value })} placeholder="123" required /></div>
              <div><label htmlFor="c-h">Name on card</label><input id="c-h" autoComplete="cc-name" value={card.holder} onChange={(e) => setCard({ ...card, holder: e.target.value })} required /></div>
              <div><label htmlFor="c-cur">Card currency</label><select id="c-cur" value={card.currency} onChange={(e) => setCard({ ...card, currency: e.target.value })}>{['GBP', 'USD', 'EUR', 'CNY', 'PKR', 'INR'].map((c) => <option key={c}>{c}</option>)}</select></div>
            </div>
          )}
          {(tab === 'alipay' || tab === 'wechatpay') && (
            <div className="field-row">
              <div><label htmlFor="w-a">{tab === 'alipay' ? 'Alipay account (mobile or email)' : 'Mobile number bound to WeChat Pay'}</label><input id="w-a" value={wallet.account} onChange={(e) => setWallet({ ...wallet, account: e.target.value })} placeholder="138 1234 5678" required /></div>
              <div><label htmlFor="w-h">Real name on the account</label><input id="w-h" value={wallet.holder} onChange={(e) => setWallet({ ...wallet, holder: e.target.value })} placeholder="张伟 / Zhang Wei" required /></div>
            </div>
          )}
          {tab === 'bank' && (
            <div className="field-row">
              <div><label htmlFor="b-b">Bank</label><select id="b-b" value={bank.bank} onChange={(e) => setBank({ ...bank, bank: e.target.value })}>
                {Object.entries((data?.banks as Json) ?? {}).map(([k, v]: [string, any]) => <option key={k} value={k}>{v.short} — {v.name} ({v.currency})</option>)}
              </select></div>
              <div><label htmlFor="b-a">Card / account number</label><input id="b-a" inputMode="numeric" value={bank.account} onChange={(e) => setBank({ ...bank, account: e.target.value })} required /></div>
              <div><label htmlFor="b-h">Account holder</label><input id="b-h" value={bank.holder} onChange={(e) => setBank({ ...bank, holder: e.target.value })} required /></div>
            </div>
          )}
          <div><button className="btn" disabled={busy}>{busy ? 'Linking…' : 'Link'}</button></div>
          <p className="hint">BridgeWise stores a token, the network and the last four digits only. Your full card number and security code are never saved.</p>
        </form>
      </section>
    </>
  );
}
