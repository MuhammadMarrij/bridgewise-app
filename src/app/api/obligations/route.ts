import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import { assertSameOrigin, fail, json, parseBody, requireSession } from '@/lib/api/http';
import { createObligation } from '@/lib/services/intake';
import { SUPPORTED_CURRENCIES } from '@/lib/domain/money';
import { safeText } from '@/lib/security/sanitize';

const currency = z.enum(SUPPORTED_CURRENCIES);

// Amounts arrive as decimal STRINGS. A JSON number would already have passed
// through a float by the time it reached us, which is how cents go missing.
const Body = z
  .object({
    description: safeText(120),
    amount: z.string().min(1).max(20),
    currency,
    beneficiaryName: safeText(120),
    beneficiaryReference: safeText(64, 3),
    deadlineDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    // Required, not optional. A date with no time is ambiguous, and a planner
    // that silently assumes midnight will one day miss a 09:00 cutoff.
    deadlineTime: z.string().regex(/^\d{2}:\d{2}$/),
    deadlineTimezone: z.string().min(3).max(64),
    reserveAmount: z.string().min(1).max(20),
    reserveCurrency: currency,
  })
  .strict();

export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const session = await requireSession(req);
    const body = await parseBody(req, Body);
    const created = await createObligation(getDb(), session, body);
    return json(
      {
        obligationId: created.obligationId,
        details: created.details,
        beneficiaryId: created.beneficiaryId,
        // The server reports the instant it RESOLVED, so the student can see
        // whether the timezone moved their deadline before they confirm it.
        deadlineAt: created.deadlineAt.toISOString(),
        confirmed: created.confirmed,
        nextStep: 'Confirm these details before planning a payment against them.',
        simulated: true,
      },
      { status: 201 },
    );
  } catch (error) {
    return fail(error);
  }
}
