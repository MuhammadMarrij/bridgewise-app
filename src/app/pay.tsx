'use client';

/**
 * Real provider checkouts. Alipay redirects to Alipay's own cashier; Stripe
 * renders Stripe's own card field, so the card number never touches BridgeWise.
 * In both cases the wallet is credited only after the server asks the provider.
 */
import { useEffect, useRef, useState } from 'react';
import { loadStripe, type Stripe, type StripeElements, type StripePaymentElement } from '@stripe/stripe-js';
import { type Json } from './ui';
import { api } from './views';

export function useProviders() {
  const [cfg, setCfg] = useState<Json | null>(null);
  useEffect(() => { api('/api/pay/config').then(setCfg).catch(() => setCfg({})); }, []);
  return cfg;
}

export function AlipayCheckout({ onError }: { onError: (m: string) => void }) {
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  async function go(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      const r = await api('/api/pay/alipay', { method: 'POST', body: JSON.stringify({ amount }) });
      window.location.href = r.payUrl;
    } catch (x: any) { onError(x.message); setBusy(false); }
  }
  return (
    <form className="stack" onSubmit={go}>
      <div><label htmlFor="ap-a">Amount (CNY)</label><input id="ap-a" inputMode="decimal" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="500.00" required /></div>
      <p className="hint">You&rsquo;ll pay on Alipay&rsquo;s own page. BridgeWise credits your CNY pocket only after Alipay confirms the trade.</p>
      <button className="btn" disabled={busy} style={{ justifyContent: 'center', background: '#1677ff', borderColor: '#1677ff', color: '#fff' }}>
        {busy ? 'Opening Alipay…' : 'Pay with Alipay 支付宝'}
      </button>
    </form>
  );
}

export function StripeCheckout({ publishableKey, currency, onDone, onError }: {
  publishableKey: string; currency: string; onDone: (msg: string) => void; onError: (m: string) => void;
}) {
  const [amount, setAmount] = useState('');
  const [ready, setReady] = useState<{ trade: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const mount = useRef<HTMLDivElement | null>(null);
  const stripeRef = useRef<Stripe | null>(null);
  const elementsRef = useRef<StripeElements | null>(null);
  const elRef = useRef<StripePaymentElement | null>(null);
  // Mount once the box exists: it is rendered only after ready is set.
  useEffect(() => { if (ready && mount.current && elRef.current) elRef.current.mount(mount.current); }, [ready]);

  async function start(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      const r = await api('/api/pay/stripe', { method: 'POST', body: JSON.stringify({ amount, currency }) });
      const stripe = await loadStripe(publishableKey);
      if (!stripe) throw new Error('Stripe could not load');
      const elements = stripe.elements({ clientSecret: r.clientSecret, appearance: { theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'stripe' } });
      elRef.current = elements.create('payment');
      stripeRef.current = stripe; elementsRef.current = elements;
      setReady({ trade: r.outTradeNo });
    } catch (x: any) { onError(x.message); } finally { setBusy(false); }
  }

  async function pay() {
    if (!stripeRef.current || !elementsRef.current || !ready) return;
    setBusy(true);
    const { error } = await stripeRef.current.confirmPayment({ elements: elementsRef.current, redirect: 'if_required' });
    if (error) { onError(error.message ?? 'Payment failed'); setBusy(false); return; }
    try {
      const c = await api('/api/pay/stripe/confirm', { method: 'POST', body: JSON.stringify({ outTradeNo: ready.trade }) });
      if (c.credited) onDone(`Card payment confirmed by Stripe. New balance ${c.balance} ${currency}.`);
      else onError(`Stripe reports ${c.status}; nothing credited yet.`);
    } catch (x: any) { onError(x.message); } finally { setBusy(false); }
  }

  return ready ? (
    <div className="stack">
      <div ref={mount} />
      <button className="btn" onClick={pay} disabled={busy} style={{ justifyContent: 'center' }}>{busy ? 'Processing…' : `Pay ${amount} ${currency}`}</button>
      <p className="hint">The card field is Stripe&rsquo;s own. Test card 4242 4242 4242 4242, any future date, any CVC.</p>
    </div>
  ) : (
    <form className="stack" onSubmit={start}>
      <div><label htmlFor="st-a">Amount ({currency})</label><input id="st-a" inputMode="decimal" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="100.00" required /></div>
      <button className="btn" disabled={busy} style={{ justifyContent: 'center' }}>{busy ? '…' : 'Continue to card'}</button>
    </form>
  );
}
