import type { NextRequest } from 'next/server';
import { getDb } from '@/lib/db/client';
import { fail, json, requireSession } from '@/lib/api/http';
import { transferStatus } from '@/lib/services/execution';
import { formatAmount } from '@/lib/domain/money';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await ctx.params;
    // Reading the status also drains any pending dispatch and reconciles against
    // the provider, so an interrupted dispatch is completed by the next reader
    // rather than needing a background worker.
    const t = await transferStatus(getDb(), session, id);
    return json({
      transferId: t.id,
      status: t.status,
      debit: formatAmount(t.debitAmountMinor, t.sourceCurrency),
      credit: formatAmount(t.creditAmountMinor, t.targetCurrency),
      sourceCurrency: t.sourceCurrency,
      targetCurrency: t.targetCurrency,
      externalReference: t.externalReference,
      createdAt: t.createdAt.toISOString(),
      deliveredAt: t.deliveredAt?.toISOString() ?? null,
      postedAt: t.postedAt?.toISOString() ?? null,
      // Stated on every receipt, because the two are routinely confused.
      tuitionPosted: t.status === 'POSTED',
      simulated: true,
    });
  } catch (error) {
    return fail(error);
  }
}
