import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import { assertSameOrigin, fail, json, parseBody, requireSession } from '@/lib/api/http';
import { confirmAndExecute } from '@/lib/services/execution';
import { formatAmount } from '@/lib/domain/money';

// Deliberately ABSENT from this body: amount, fee, rate, beneficiary, account.
// The server owns every term. A client-supplied `approved: true` would mean
// nothing here, because authority comes from the stored one-use approval.
const Body = z
  .object({
    expectedTermsHash: z.string().length(64),
    nonce: z.string().min(16).max(128),
    idempotencyKey: z.string().min(8).max(128),
  })
  .strict();

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(req);
    const session = await requireSession(req);
    const { id } = await ctx.params;
    const body = await parseBody(req, Body);
    const transfer = await confirmAndExecute(getDb(), session, { planId: id, ...body });
    return json({
      transferId: transfer.id,
      status: transfer.status,
      debit: formatAmount(transfer.debitAmountMinor, transfer.sourceCurrency),
      credit: formatAmount(transfer.creditAmountMinor, transfer.targetCurrency),
      sourceCurrency: transfer.sourceCurrency,
      targetCurrency: transfer.targetCurrency,
      externalReference: transfer.externalReference,
      // Submitted is not delivered, and delivered is not paid.
      tuitionPosted: transfer.status === 'POSTED',
      simulated: true,
    });
  } catch (error) {
    return fail(error);
  }
}
