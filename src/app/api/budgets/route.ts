import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import { assertSameOrigin, fail, json, parseBody, requireSession } from '@/lib/api/http';
import { SUPPORTED_CURRENCIES, type Currency } from '@/lib/domain/money';
import { listBudgets, setBudget } from '@/lib/services/money-ops';
import { CATEGORIES, type Category } from '@/lib/services/statement';

export const dynamic = 'force-dynamic';

const Body = z.object({
  category: z.enum(CATEGORIES),
  currency: z.enum(SUPPORTED_CURRENCIES),
  monthlyLimit: z.string().min(1).max(20),
}).strict();

export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    return json({ budgets: await listBudgets(getDb(), session.id) });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const session = await requireSession(req);
    const b = await parseBody(req, Body);
    await setBudget(getDb(), session, { category: b.category as Category, currency: b.currency as Currency, monthlyLimit: b.monthlyLimit });
    return json({ budgets: await listBudgets(getDb(), session.id) });
  } catch (error) {
    return fail(error);
  }
}
