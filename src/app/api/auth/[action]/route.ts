import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import { assertSameOrigin, clientKey, fail, json, parseBody, rateLimit, requireSession } from '@/lib/api/http';
import { SUPPORTED_CURRENCIES, type Currency } from '@/lib/domain/money';
import { SESSION_DAYS, signIn, signOut, signUp } from '@/lib/services/auth';
import { SESSION_COOKIE } from '@/lib/services/workspace';
import { safeText } from '@/lib/security/sanitize';

const SignUp = z.object({
  email: z.string().min(3).max(120),
  password: z.string().min(1).max(200),
  name: safeText(40),
  homeCurrency: z.enum(SUPPORTED_CURRENCIES),
  studyCurrency: z.enum(SUPPORTED_CURRENCIES),
}).strict();
const SignIn = z.object({ email: z.string().min(3).max(120), password: z.string().min(1).max(200) }).strict();

function withCookie(res: Response, token: string | null) {
  const r = res as unknown as { cookies: { set: (n: string, v: string, o: object) => void } };
  r.cookies.set(SESSION_COOKIE, token ?? '', {
    httpOnly: true, sameSite: 'strict', secure: process.env.APP_ENV === 'hosted_demo' || process.env.VERCEL === '1',
    path: '/', maxAge: token ? SESSION_DAYS * 86_400 : 0,
  });
  return res;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ action: string }> }) {
  try {
    assertSameOrigin(req);
    const { action } = await ctx.params;
    const db = getDb();
    if (action === 'signup') {
      await rateLimit(`signup:${clientKey(req)}`, 10, 60_000);
      const b = await parseBody(req, SignUp);
      const out = await signUp(db, { ...b, homeCurrency: b.homeCurrency as Currency, studyCurrency: b.studyCurrency as Currency });
      return withCookie(json({ ok: true, name: b.name }, { status: 201 }), out.token);
    }
    if (action === 'signin') {
      const b = await parseBody(req, SignIn);
      // Slow down guessing per address and per client.
      await rateLimit(`signin:${b.email.toLowerCase()}`, 5, 60_000);
      await rateLimit(`signin-ip:${clientKey(req)}`, 20, 60_000);
      const out = await signIn(db, b.email, b.password);
      return withCookie(json({ ok: true, name: out.name }), out.token);
    }
    if (action === 'signout') {
      const session = await requireSession(req).catch(() => null);
      if (session) await signOut(db, session.id);
      return withCookie(json({ ok: true }), null);
    }
    return json({ code: 'NOT_FOUND', message: 'unknown action' }, { status: 404 });
  } catch (error) {
    return fail(error);
  }
}
