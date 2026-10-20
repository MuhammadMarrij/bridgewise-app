import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import { assertSameOrigin, clientKey, fail, json, parseBody, rateLimit, assertLegacyDemoEnabled } from '@/lib/api/http';
import { SUPPORTED_CURRENCIES } from '@/lib/domain/money';
import { openStudentAccount } from '@/lib/services/wallet';
import { SESSION_COOKIE } from '@/lib/services/workspace';
import { safeText } from '@/lib/security/sanitize';

const Body = z
  .object({
    name: safeText(40),
    homeCurrency: z.enum(SUPPORTED_CURRENCIES),
    studyCurrency: z.enum(SUPPORTED_CURRENCIES),
    homeBalance: z.string().min(1).max(20),
    studyBalance: z.string().min(1).max(20),
  })
  .strict();

export async function POST(req: NextRequest) {
  try {
    // Opens a wallet without an account: tests and local runs only.
    assertLegacyDemoEnabled();
    assertSameOrigin(req);
    await rateLimit(`onboard:${clientKey(req)}`, Number(process.env.SESSION_RATE_LIMIT_PER_MINUTE ?? 20), 60_000);
    const body = await parseBody(req, Body);
    const opened = await openStudentAccount(getDb(), body as never);
    const res = json({ ok: true }, { status: 201 });
    res.cookies.set(SESSION_COOKIE, opened.token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.APP_ENV === 'hosted_demo',
      path: '/',
      maxAge: 7 * 24 * 3600,
    });
    return res;
  } catch (error) {
    return fail(error);
  }
}
