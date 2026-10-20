/**
 * A hard cap on live-model spending, in dollars, so one visitor (or a loop)
 * cannot burn the API credit that testers and judges need. Counted from
 * agent_runs, which records the tokens the API itself reported for every live
 * turn (input already folds in cache writes and discounted cache reads).
 *
 * - Lifetime: MODEL_TOTAL_BUDGET_USD across all time (default $10, half of a
 *   $20 credit).
 * - Daily: MODEL_DAILY_BUDGET_USD per UTC day (default $0.50).
 * - Per student: MODEL_TURNS_PER_STUDENT_DAY live turns per UTC day (default 10).
 * Prices default to Claude Haiku 5.5's list price for prompts up to 100K tokens:
 * $0.10 per million input, $0.50 per million output. Over any limit the
 * assistant still works, on the guided planner, and says why.
 */
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

type Db = NodePgDatabase<Record<string, never>>;

const num = (k: string, d: number) => Number(process.env[k] ?? d);
export const TOTAL_BUDGET_USD = () => num('MODEL_TOTAL_BUDGET_USD', 10);
export const DAILY_BUDGET_USD = () => num('MODEL_DAILY_BUDGET_USD', 0.5);
export const TURNS_PER_STUDENT_DAY = () => num('MODEL_TURNS_PER_STUDENT_DAY', 10);
const PRICE_IN = () => num('MODEL_PRICE_IN_PER_M', 0.1) / 1_000_000;
const PRICE_OUT = () => num('MODEL_PRICE_OUT_PER_M', 0.5) / 1_000_000;

export interface Budget { allowed: boolean; reason: string | null; spentTotalUsd: number; spentTodayUsd: number; turnsToday: number }

export async function liveBudget(db: Db, sessionId: string): Promise<Budget> {
  // A run that failed before the API reported usage is charged a pessimistic guess.
  const r = await db.execute(sql`
    SELECT
      COALESCE(SUM(COALESCE(input_tokens, 20000)), 0)::bigint AS in_all,
      COALESCE(SUM(COALESCE(output_tokens, 700)), 0)::bigint AS out_all,
      COALESCE(SUM(COALESCE(input_tokens, 20000)) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), 0)::bigint AS in_today,
      COALESCE(SUM(COALESCE(output_tokens, 700)) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), 0)::bigint AS out_today,
      COUNT(*) FILTER (WHERE session_id = ${sessionId} AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::int AS mine
    FROM agent_runs
    WHERE mode = 'live'`);
  const row = (r as unknown as { rows: Array<Record<string, string | number>> }).rows[0]!;
  const cost = (i: unknown, o: unknown) => Number(i) * PRICE_IN() + Number(o) * PRICE_OUT();
  const spentTotalUsd = cost(row.in_all, row.out_all);
  const spentTodayUsd = cost(row.in_today, row.out_today);
  const turnsToday = Number(row.mine);
  const out = (reason: string | null): Budget => ({ allowed: !reason, reason, spentTotalUsd, spentTodayUsd, turnsToday });
  if (spentTotalUsd >= TOTAL_BUDGET_USD()) return out('the live AI has used its whole budget');
  if (spentTodayUsd >= DAILY_BUDGET_USD()) return out('the live AI has used today\'s budget');
  if (turnsToday >= TURNS_PER_STUDENT_DAY()) return out(`you have used today's ${TURNS_PER_STUDENT_DAY()} live AI answers`);
  return out(null);
}
