import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import { assertSameOrigin, clientKey, fail, json, parseBody, rateLimit } from '@/lib/api/http';
import { SESSION_COOKIE, SESSION_LIFETIME_MS, createWorkspace } from '@/lib/services/workspace';

const Body = z
  .object({ scenario: z.enum(['golden', 'tight', 'global']).default('golden') })
  .strict();

export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    // A public demo must not become a free database. Session creation is bounded.
    // Configurable because a browser test suite legitimately creates many
    // workspaces from one address. The control stays; only its threshold moves,
    // and the default is the conservative one.
    rateLimit(`sessions:${clientKey(req)}`, Number(process.env.SESSION_RATE_LIMIT_PER_MINUTE ?? 20), 60_000);
    const body = await parseBody(req, Body);
    const created = await createWorkspace(getDb(), { kind: body.scenario });

    const res = json(
      {
        obligationId: created.obligationId,
        obligationIds: created.obligationIds,
        sourceAccountId: created.sourceAccountId,
        kind: created.kind,
        scenario: body.scenario,
        simulated: true,
      },
      { status: 201 },
    );

    // The token lives only in an HttpOnly cookie: never in the body, never in a
    // URL, never readable by page scripts.
    res.cookies.set(SESSION_COOKIE, created.token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.APP_ENV === 'hosted_demo',
      path: '/',
      maxAge: Math.floor(SESSION_LIFETIME_MS / 1000),
    });
    return res;
  } catch (error) {
    return fail(error);
  }
}
