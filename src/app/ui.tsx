'use client';

/**
 * Shared interface pieces. Every money figure is rendered exactly as the server
 * sent it — there is no arithmetic in the client.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

export type Json = Record<string, any>;

/* ------------------------------------------------------------------- icons */

const PATHS: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  wallet: 'M3 7a2 2 0 0 1 2-2h13v4M3 7v11a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2zm14 7h.01',
  bill: 'M6 2h9l5 5v15H6zM14 2v6h6M9 13h7M9 17h5',
  send: 'M22 2 11 13M22 2l-7 20-4-9-9-4z',
  chart: 'M3 3v18h18M7 15l4-4 3 3 5-6',
  spark: 'M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z',
  check: 'M20 6 9 17l-5-5',
  x: 'M18 6 6 18M6 6l12 12',
  alert: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  clock: 'M12 7v5l3 3M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  swap: 'M7 16V4m0 0L3 8m4-4 4 4M17 8v12m0 0 4-4m-4 4-4-4',
  up: 'M7 17 17 7M8 7h9v9',
  down: 'M17 7 7 17M16 17H7V8',
  bell: 'M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  card: 'M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2zM2 10h20',
};

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? PATHS.spark} />
    </svg>
  );
}

const CCY_COLOR: Record<string, string> = {
  GBP: '#3b4cca', USD: '#0e8a5f', EUR: '#2a6fdb', CNY: '#d23b3b', PKR: '#0f7a3d',
  INR: '#e07b00', AUD: '#7a3dd2', CAD: '#c2185b', JPY: '#b71c1c', KRW: '#1565c0', AED: '#6d4c41',
};
export function CcyBadge({ ccy }: { ccy: string }) {
  return <span className="ccy-badge" style={{ background: CCY_COLOR[ccy] ?? '#5b6576' }} aria-hidden="true">{ccy}</span>;
}

/** Grouped for display only. Never parsed back into arithmetic. */
export function money(value: string | null | undefined, ccy?: string): string {
  if (value === null || value === undefined) return '—';
  const neg = value.startsWith('-');
  const [w = '0', f] = (neg ? value.slice(1) : value).split('.');
  const g = w.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '−' : ''}${f !== undefined ? `${g}.${f}` : g}${ccy ? ` ${ccy}` : ''}`;
}

/* --------------------------------------------------------------- countdown */

function useCountdown(iso: string): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return 'expired';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/* ----------------------------------------------------------- approval card */

export function ApprovalCard({
  p, onApprove, onDecline, busy,
}: { p: Json; onApprove: (p: Json, password?: string) => void; onDecline: (p: Json) => void; busy?: boolean }) {
  const t = p.terms ?? {};
  // Real money leaving through a provider needs the password again.
  const payout = p.kind === 'send' || p.kind === 'withdraw' || (p.kind === 'pay_bill' && t.rail === 'alipay');
  const [pw, setPw] = useState('');
  const left = useCountdown(p.expiresAt);
  const status = p.status === 'PENDING' && left === 'expired' ? 'EXPIRED' : p.status;
  const done = status === 'EXECUTED';
  const closed = status === 'DECLINED' || status === 'EXPIRED' || status === 'FAILED';

  const rows: Array<[string, ReactNode]> =
    p.kind === 'convert'
      ? [
          ['You sell', money(t.sellAmount, t.from)],
          ['You get', <strong key="g">{money(t.buyAmount, t.to)}</strong>],
          ['Rate', `${t.customerRate}`],
          ['Mid-market (ECB)', `${t.midRate}`],
          ['Our fee', `${money(t.marginCostInTarget, t.to)} · ${Number(t.marginBps) / 100}%`],
        ]
      : p.kind === 'withdraw'
      ? ([
          ['Arrives', <strong key="w">{money(t.receiveAmount, t.receiveCurrency)}</strong>],
          ['To', t.sourceLabel],
          ['You pay', money(t.debitAmount, t.fromCurrency)],
          ...(t.customerRate ? ([['Rate', `${t.customerRate} (mid ${t.midRate})`]] as Array<[string, ReactNode]>) : []),
          ['Left in pocket', money(t.leftInPocketAfter, t.fromCurrency)],
        ] as Array<[string, ReactNode]>)
      : p.kind === 'send'
      ? ([
          ['They receive', <strong key="r">{money(t.receiveAmount, t.receiveCurrency)}</strong>],
          ['To', `${t.recipientName} · ${t.accountLabel}`],
          ['You pay', money(t.debitAmount, t.fromCurrency)],
          ...(t.customerRate ? ([['Rate', `${t.customerRate} (mid ${t.midRate})`]] as Array<[string, ReactNode]>) : []),
          ['Fee', money(t.feeAmount, t.fromCurrency)],
          ['Left in pocket', money(t.leftInPocketAfter, t.fromCurrency)],
        ] as Array<[string, ReactNode]>)
      : [
          ['Pay', <strong key="p">{money(t.billAmount, t.billCurrency)}</strong>],
          ['To', t.payee],
          ['Reference', t.beneficiaryReference],
          ['From', `${t.fromCurrency} pocket`],
          ['It costs you', money(t.debitAmount, t.fromCurrency)],
          ...(t.customerRate ? ([['Rate', `${t.customerRate} (mid ${t.midRate})`]] as Array<[string, ReactNode]>) : []),
          ['Left in pocket', money(t.leftInPocketAfter, t.fromCurrency)],
          ['Due', new Date(t.dueAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })],
        ];

  return (
    <div className={`approval ${done ? 'done' : ''} ${closed ? 'closed' : ''}`}>
      <div className="approval-head">
        <Icon name={done ? 'check' : p.kind === 'convert' ? 'swap' : p.kind === 'send' ? 'send' : 'bill'} />
        <h3 className="grow" style={{ flex: 1 }}>{p.title}</h3>
        {done ? <span className="tag ok">Done</span>
          : closed ? <span className="tag">{status.toLowerCase()}</span>
          : <span className="tag brand"><Icon name="clock" size={12} /> {left}</span>}
      </div>
      <div className="approval-body">
        <dl className="terms">
          {rows.map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v}</dd></div>
          ))}
        </dl>
        {done && p.result && (
          <p className="small" style={{ color: 'var(--ok)' }}>
            {p.kind === 'pay_bill' && p.result.status === 'SET_ASIDE'
              ? `${p.result.setAside} set aside for ${p.result.for}. Pay it through their own portal with reference ${p.result.reference}, then mark the bill paid.`
              : p.kind === 'pay_bill'
              ? `Paid ${p.result.paid} to ${p.result.to} through Alipay.`
              : p.kind === 'send'
              ? `Sent ${p.result.sent} to ${p.result.to}.`
              : p.kind === 'withdraw'
              ? `Moved ${p.result.moved} to ${p.result.to} · ref ${p.result.reference}.`
              : `Converted: ${p.result.sold} → ${p.result.bought}.`}
          </p>
        )}
        {status === 'PENDING' && (
          <>
            {payout && (
              <div style={{ marginBottom: '.6rem' }}>
                <label htmlFor={`pw-${p.id}`}>Your password, to send real money</label>
                <input id={`pw-${p.id}`} type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
              </div>
            )}
            <div className="actions">
              <button className="btn" disabled={busy || (payout && !pw)} onClick={() => onApprove(p, payout ? pw : undefined)}>
                <Icon name="check" size={16} /> {busy ? 'Approving…' : 'Approve'}
              </button>
              <button className="btn secondary" disabled={busy} onClick={() => onDecline(p)}>Decline</button>
            </div>
            <p className="fingerprint">
              {p.proposedBy === 'agent' ? 'Prepared by your assistant' : 'Prepared by you'} · terms {String(p.termsHash).slice(0, 12)}… · nothing moves until you approve
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- sparkline */

export function Sparkline({ points, small }: { points: Array<{ date: string; rate: number }>; small?: boolean }) {
  if (!points || points.length < 2) return null;
  const w = 600, h = small ? 60 : 160, pad = small ? 2 : 8;
  const vals = points.map((p) => p.rate);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const x = (i: number) => pad + (i / (points.length - 1)) * (w - 2 * pad);
  const y = (v: number) => h - pad - ((v - min) / span) * (h - 2 * pad);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.rate).toFixed(1)}`).join(' ');
  const up = vals[vals.length - 1]! >= vals[0]!;
  const color = up ? 'var(--ok)' : 'var(--bad)';
  return (
    <svg className={small ? 'spark-sm' : 'spark'} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none"
      role="img" aria-label={`Rate from ${points[0]!.rate} to ${points[points.length - 1]!.rate} over ${points.length} days`}>
      {!small && (
        <path d={`${d} L${x(points.length - 1)},${h} L${x(0)},${h} Z`} fill={color} opacity="0.08" />
      )}
      <path d={d} fill="none" stroke={color} strokeWidth={small ? 3 : 2.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/* --------------------------------------------------------------- assistant */

export interface ChatMsg { role: 'user' | 'assistant'; content: string; steps?: Json[]; proposals?: string[]; mode?: string }

const STEP_LABEL: Record<string, string> = {
  get_overview: 'read your accounts',
  get_fx: 'checked ECB rates',
  compare_live_providers: 'compared 17 providers',
  read_invoice: 'read the invoice',
  add_bill: 'saved the bill',
  propose_bill_payment: 'prepared payment',
  propose_conversion: 'prepared conversion',
  set_rate_alert: 'set an alert',
  get_transactions: 'read your statement',
  get_spending: 'analysed your spending',
  list_recipients: 'checked your recipients',
  propose_transfer: 'prepared transfer',
  set_budget: 'set a budget',
  list_linked_accounts: 'checked linked accounts',
  propose_withdrawal: 'prepared withdrawal',
  get_credit_plan: 'checked your credit plan',
};

export function Assistant({
  messages, onSend, busy, proposals, onApprove, onDecline, approving, open, onClose, name,
}: {
  messages: ChatMsg[]; onSend: (text: string) => void; busy: boolean; proposals: Map<string, Json>;
  onApprove: (p: Json, password?: string) => void; onDecline: (p: Json) => void; approving: string | null;
  open: boolean; onClose: () => void; name: string;
}) {
  const [text, setText] = useState('');
  const log = useRef<HTMLDivElement | null>(null);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' }); }, [messages.length, busy]);

  const submit = () => {
    const t = text.trim();
    if (!t || busy) return;
    setText('');
    onSend(t);
  };
  const lastMode = [...messages].reverse().find((m) => m.mode)?.mode;

  return (
    <aside className={`assistant ${open ? 'open' : ''}`} aria-label="BridgeWise assistant">
      <div className="assistant-head">
        <span className="avatar"><Icon name="spark" /></span>
        <div style={{ flex: 1 }}>
          <strong>BridgeWise Assistant</strong>
          <div className="mode">{lastMode === 'live' ? 'Live AI model' : lastMode === 'guided' ? 'Guided mode · same tools, no live model' : 'Prepares actions · you approve'}</div>
        </div>
        <button className="btn secondary small assistant-close" onClick={onClose} aria-label="Close assistant"><Icon name="x" size={14} /></button>
      </div>

      <div className="assistant-log" ref={log} aria-live="polite">
        {messages.length === 0 && (
          <div className="msg bot">
            Hi {name}. I watch your money across currencies, read your invoices, compare real providers and prepare
            payments and conversions for you. I never move money myself — you approve every action.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '.5rem', alignItems: m.role === 'user' ? 'flex-end' : 'stretch' }}>
            <div className={`msg ${m.role === 'user' ? 'user' : 'bot'}`}>
              {m.content}
              {m.steps && m.steps.length > 0 && (
                <div className="steps">
                  {m.steps.map((s, j) => (
                    <span key={j} className="step">{s.ok ? '✓' : '✗'} {STEP_LABEL[s.tool] ?? s.tool}</span>
                  ))}
                </div>
              )}
            </div>
            {(m.proposals ?? []).map((id) => {
              const p = proposals.get(id);
              return p ? <ApprovalCard key={id} p={p} onApprove={onApprove} onDecline={onDecline} busy={approving === id} /> : null;
            })}
          </div>
        ))}
        {busy && <div className="msg bot faint">Working on it…</div>}
      </div>

      <div className="assistant-foot">
        <div className="chips">
          {["What's my situation?", 'Pay my tuition', 'How is my exchange rate doing?', 'Cheapest way to send money'].map((c) => (
            <button key={c} className="chip" onClick={() => !busy && onSend(c)}>{c}</button>
          ))}
        </div>
        <div className="composer">
          <label htmlFor="ask" className="skip">Message the assistant</label>
          <textarea
            id="ask"
            rows={1}
            placeholder="Ask anything, or paste an invoice…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
          />
          <button className="btn" onClick={submit} disabled={busy || !text.trim()} aria-label="Send"><Icon name="send" size={16} /></button>
        </div>
      </div>
    </aside>
  );
}

/* -------------------------------------------------------------------- donut */

const DONUT = ['#0b5cff', '#7c4dff', '#0e8a5f', '#e07b00', '#d23b3b', '#00a3bf', '#8a94a6', '#c2185b'];

export function Donut({ items, center }: { items: Array<{ label: string; value: number }>; center: ReactNode }) {
  const total = items.reduce((a, b) => a + b.value, 0) || 1;
  let acc = 0;
  const r = 52, c = 2 * Math.PI * r;
  return (
    <div className="donut">
      <svg viewBox="0 0 140 140" width="160" height="160" role="img" aria-label="Spending by category">
        <circle cx="70" cy="70" r={r} fill="none" stroke="var(--line)" strokeWidth="18" />
        {items.map((it, i) => {
          const len = (it.value / total) * c;
          const el = (
            <circle key={it.label} cx="70" cy="70" r={r} fill="none" stroke={DONUT[i % DONUT.length]} strokeWidth="18"
              strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-acc} transform="rotate(-90 70 70)" />
          );
          acc += len;
          return el;
        })}
      </svg>
      <div className="donut-center">{center}</div>
      <ul className="legend">
        {items.map((it, i) => (
          <li key={it.label}><span className="sw" style={{ background: DONUT[i % DONUT.length] }} />{it.label}<span className="num">{Math.round((it.value / total) * 100)}%</span></li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------- sheet */

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet card" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="card-head"><h2>{title}</h2><button className="btn secondary small" onClick={onClose} aria-label="Close"><Icon name="x" size={14} /></button></div>
        {children}
      </div>
    </div>
  );
}

export const CATEGORY_ICON: Record<string, string> = {
  tuition: '🎓', rent: '🏠', food: '🍜', transport: '🚇', bills: '🧾', shopping: '🛍️', family: '👪', fx: '💱', income: '⬇️', other: '•',
};
