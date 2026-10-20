'use client';

/**
 * BridgeWise app shell: navigation, data, and the assistant.
 *
 * The assistant is not a feature on a page; it sits beside every page, sees the
 * same account, and its proposals appear as approval cards wherever the student
 * is. Approving goes straight to the execution service with the terms hash the
 * card displayed.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Assistant, Icon, type ChatMsg, type Json } from './ui';
import { Bills, Home, Markets, Onboarding, Wallet, api, type Ctx } from './views';
import { Activity, AddMoney, Budget, RecordPayment, SendMoney } from './views2';

const TABS = [
  { id: 'home', label: 'Home', icon: 'home', mobile: true },
  { id: 'wallet', label: 'Wallet', icon: 'wallet', mobile: true },
  { id: 'activity', label: 'Activity', icon: 'clock', mobile: true },
  { id: 'send', label: 'Send', icon: 'send', mobile: true },
  { id: 'budget', label: 'Budget', icon: 'chart', mobile: true },
  { id: 'bills', label: 'Bills', icon: 'bill', mobile: false },
  { id: 'markets', label: 'Markets', icon: 'up', mobile: false },
] as const;

const TITLES: Record<string, [string, string]> = {
  home: ['', 'Here is where your money stands today.'],
  wallet: ['Wallet', 'One pocket per currency, valued at live rates.'],
  bills: ['Bills', 'Tuition and fees — read from your invoice, paid on your approval.'],
  send: ['Send money', 'To family, friends and landlords — and what the market would charge you.'],
  activity: ['Activity', 'Every movement on every pocket, with the balance after it.'],
  budget: ['Budget', 'Where your money goes, and how long it will last.'],
  markets: ['Markets', 'The exchange rates that matter to you.'],
};

export default function App() {
  const [data, setData] = useState<Json | null>(null);
  const [state, setState] = useState<'loading' | 'onboard' | 'ready'>('loading');
  const [tab, setTab] = useState<string>('home');
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [thinking, setThinking] = useState(false);
  const [approving, setApproving] = useState<string | null>(null);
  const [panel, setPanel] = useState(false);
  const [toast, setToast] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [name, setName] = useState('there');
  const [sheet, setSheet] = useState<'add' | 'pay' | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(await api('/api/wallet'));
      setState('ready');
    } catch (e: any) {
      if (e.status === 401) setState('onboard');
      else setToast({ kind: 'error', text: e.message });
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 5000); return () => clearTimeout(t); }, [toast]);
  useEffect(() => { try { const n = localStorage.getItem('bw-name'); if (n) setName(n); } catch { /* private mode */ } }, []);

  const proposals = useMemo(() => new Map<string, Json>(((data?.proposals as Json[]) ?? []).map((p) => [p.id, p])), [data]);

  const ask = useCallback(async (text: string) => {
    setPanel(true);
    const history = chat.slice(-10).map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
    setChat((c) => [...c, { role: 'user', content: text }]);
    setThinking(true);
    try {
      const r = await api('/api/assistant', { method: 'POST', body: JSON.stringify({ message: text, history }) });
      setChat((c) => [...c, { role: 'assistant', content: r.reply || '…', steps: r.steps, proposals: r.proposals, mode: r.mode }]);
      await refresh();
    } catch (e: any) {
      setChat((c) => [...c, { role: 'assistant', content: `Sorry — ${e.message}` }]);
    } finally {
      setThinking(false);
    }
  }, [chat, refresh]);

  const approve = useCallback(async (p: Json) => {
    setApproving(p.id);
    try {
      await api(`/api/proposals/${p.id}/approve`, { method: 'POST', body: JSON.stringify({ expectedTermsHash: p.termsHash }) });
      setToast({ kind: 'ok', text: `${p.title} — done.` });
      await refresh();
    } catch (e: any) {
      setToast({ kind: 'error', text: e.message });
      await refresh();
    } finally {
      setApproving(null);
    }
  }, [refresh]);

  const decline = useCallback(async (p: Json) => {
    try { await api(`/api/proposals/${p.id}/decline`, { method: 'POST', body: '{}' }); await refresh(); }
    catch (e: any) { setToast({ kind: 'error', text: e.message }); }
  }, [refresh]);

  if (state === 'loading') return <main id="main" className="main"><p className="muted">Loading your account…</p></main>;
  if (state === 'onboard') {
    return <main id="main"><Onboarding onDone={() => { try { setName(localStorage.getItem('bw-name') ?? 'there'); } catch { /* */ } refresh(); }} /></main>;
  }

  const ctx: Ctx = { data: data!, refresh, ask, approve, decline, approving, go: setTab, sheet: setSheet };
  const [title, sub] = TITLES[tab]!;
  const greeting = (() => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; })();

  return (
    <div className="shell">
      <nav className="side" aria-label="Main">
        <div className="logo"><span className="logo-mark">BW</span> BridgeWise</div>
        <div className="nav">
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)} aria-current={tab === t.id ? 'page' : undefined}>
              <Icon name={t.icon} /> {t.label}
            </button>
          ))}
        </div>
        <div className="side-foot">
          <Icon name="shield" size={13} /> Every action is approved by you. Rates: ECB and live provider quotes. Balances held in BridgeWise&rsquo;s own ledger.
        </div>
      </nav>

      <div className="mobile-top">
        <div className="logo" style={{ padding: 0 }}><span className="logo-mark">BW</span> BridgeWise</div>
      </div>

      <main id="main" className="main">
        <div className="main-inner">
          <div className="page-head">
            <div>
              <h1>{tab === 'home' ? `${greeting}, ${name}` : title}</h1>
              <p className="muted">{sub}</p>
            </div>
            <button className="btn secondary small" onClick={() => setPanel(true)}><Icon name="spark" size={14} /> Ask BridgeWise</button>
          </div>
          {toast && <div className={`notice ${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>{toast.text}</div>}
          {tab === 'home' && <Home {...ctx} />}
          {tab === 'wallet' && <Wallet {...ctx} />}
          {tab === 'bills' && <Bills {...ctx} />}
          {tab === 'send' && <SendMoney {...ctx} />}
          {tab === 'activity' && <Activity {...ctx} />}
          {tab === 'budget' && <Budget {...ctx} />}
          {tab === 'markets' && <Markets {...ctx} />}
        </div>
      </main>

      <Assistant
        messages={chat} onSend={ask} busy={thinking} proposals={proposals}
        onApprove={approve} onDecline={decline} approving={approving}
        open={panel} onClose={() => setPanel(false)} name={name}
      />

      <button className="btn fab" onClick={() => setPanel(true)}><Icon name="spark" /> Assistant</button>

      {sheet === 'add' && <AddMoney ctx={ctx} onClose={() => setSheet(null)} />}
      {sheet === 'pay' && <RecordPayment ctx={ctx} onClose={() => setSheet(null)} />}

      <nav className="tabbar" aria-label="Main">
        {TABS.filter((t) => t.mobile).map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} aria-current={tab === t.id ? 'page' : undefined}>
            <Icon name={t.icon} size={20} /> {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
