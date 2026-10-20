'use client';

import { useCallback, useEffect, useState } from 'react';
import { Icon, type Json } from './ui';
import { api, type Ctx } from './views';

export function Credit(ctx: Ctx) {
  const [plan, setPlan] = useState<Json | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => setPlan(await api('/api/credit')), []);
  useEffect(() => { load().catch((e) => setErr(e.message)); }, [load, ctx.data]);

  async function mark(stepId: string, done: boolean) {
    try { setPlan(await api('/api/credit', { method: 'POST', body: JSON.stringify({ stepId, done }) })); }
    catch (e: any) { setErr(e.message); }
  }

  if (!plan) return <p className="muted">{err ?? 'Loading your credit plan…'}</p>;
  const pct = plan.readiness as number;
  const systems = ['征信 PBOC', '芝麻信用 Sesame', '微信支付分 WeChat Pay Score', 'Foundations'];

  return (
    <>
      <div className="grid-2 wide-right">
        <section className="card" style={{ textAlign: 'center' }}>
          <p className="faint small" style={{ textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 700 }}>Credit-readiness</p>
          <svg viewBox="0 0 120 70" width="220" style={{ margin: '.5rem auto 0', display: 'block' }} role="img" aria-label={`Readiness ${pct} out of 100`}>
            <path d="M10 60 A50 50 0 0 1 110 60" fill="none" stroke="var(--line)" strokeWidth="10" strokeLinecap="round" />
            <path d="M10 60 A50 50 0 0 1 110 60" fill="none" stroke={pct >= 70 ? 'var(--ok)' : pct >= 40 ? 'var(--warn)' : 'var(--bad)'} strokeWidth="10" strokeLinecap="round"
              strokeDasharray={`${(pct / 100) * 157} 157`} />
            <text x="60" y="56" textAnchor="middle" fontSize="22" fontWeight="700" fill="currentColor">{pct}</text>
          </svg>
          <p className="small muted" style={{ marginTop: '.5rem' }}>{plan.readinessNote}</p>
          <p className="small" style={{ marginTop: '.5rem' }}>{plan.onTimePayments} on-time payment{plan.onTimePayments === 1 ? '' : 's'} · {plan.latePayments} late</p>
        </section>
        <section className="card">
          <div className="card-head"><h2>Your next step</h2>
            <button className="btn secondary small" onClick={() => ctx.ask('How do I build credit in China as a foreign student? What should I do next?')}><Icon name="spark" size={14} /> Ask the assistant</button></div>
          {plan.next ? (
            <div className="stack">
              <span className="tag brand" style={{ alignSelf: 'flex-start' }}>{plan.next.system}</span>
              <h3 style={{ fontSize: '1.05rem' }}>{plan.next.title}</h3>
              <p className="muted small">{plan.next.why}</p>
              <p className="small">{plan.next.how}</p>
            </div>
          ) : <p className="muted">Every step done. Keep paying on time.</p>}
        </section>
      </div>

      {systems.map((sys) => {
        const steps = (plan.steps as Json[]).filter((s) => s.system === sys);
        if (!steps.length) return null;
        return (
          <section className="card" key={sys}>
            <div className="card-head"><h2>{sys}</h2><span className="faint small">{steps.filter((s) => s.done).length}/{steps.length} done</span></div>
            {steps.map((s) => (
              <div key={s.id} className="insight" style={{ gridTemplateColumns: '34px minmax(0,1fr) auto' }}>
                <span className="dot" style={{ background: s.done ? 'var(--ok-soft)' : 'var(--surface-2)', color: s.done ? 'var(--ok)' : 'var(--faint)' }}><Icon name={s.done ? 'check' : 'clock'} size={16} /></span>
                <div><h3>{s.title}</h3><p>{s.why}</p><p style={{ marginTop: '.3rem', color: 'var(--ink)' }}>{s.how}</p>
                  {s.detectedBy === 'auto' && <p className="small" style={{ color: 'var(--ok)', marginTop: '.3rem' }}>Detected from your BridgeWise account</p>}</div>
                {s.detectedBy !== 'auto' && ['alipay-realname', 'wechat-realname', 'pboc-report', 'credit-card', 'cn-bank'].includes(s.id) && (
                  <button className="btn secondary small" onClick={() => mark(s.id, !s.done)}>{s.done ? 'Undo' : 'Mark done'}</button>
                )}
              </div>
            ))}
          </section>
        );
      })}
      {err && <div className="notice error" role="alert">{err}</div>}
    </>
  );
}
