/**
 * The student-facing statement. Every call happens inside the same transaction
 * as the balance change and its ledger entries, so a statement row exists if
 * and only if the money moved.
 */
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { walletTransactions } from '../db/schema';

type Db = NodePgDatabase<Record<string, never>>;

export const CATEGORIES = [
  'tuition', 'rent', 'food', 'transport', 'bills', 'shopping', 'family', 'fx', 'income', 'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface StatementRow {
  sessionId: string;
  accountId: string;
  kind: 'topup' | 'convert_out' | 'convert_in' | 'bill' | 'send' | 'spend' | 'opening' | 'withdraw';
  linkedSourceId?: string | null;
  description: string;
  category: Category;
  currency: string;
  amountMinor: bigint;
  balanceAfterMinor: bigint;
  counterparty?: string | null;
  proposalId?: string | null;
  idempotencyKey?: string | null;
}

export async function postStatement(tx: Db, row: StatementRow): Promise<void> {
  await tx.insert(walletTransactions).values({
    ...row,
    description: row.description.slice(0, 140),
    counterparty: row.counterparty?.slice(0, 120) ?? null,
    proposalId: row.proposalId ?? null,
    idempotencyKey: row.idempotencyKey ?? null,
    linkedSourceId: row.linkedSourceId ?? null,
  });
}
