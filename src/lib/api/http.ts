/**
 * The HTTP boundary: validation, session resolution, origin checking and a single
 * error envelope. Nothing past this layer trusts anything from the request.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDb, getPool } from '../db/client';
import { AppError, isAppError } from '../services/errors';
import { MoneyError } from '../domain/money';
import { SESSION_COOKIE, resolveSession, type ResolvedSession } from '../services/workspace';

export interface ErrorBody {
  code: string;
  message: string;
  correlationId: string;
  fieldErrors?: Record<string, string>;
}

export function fail(error: unknown, correlationId = randomUUID()): NextResponse {
  // A malformed amount, rate or currency is the caller's mistake, not a server
  // fault: report it as a validation error with the parser's own message.
  if (error instanceof MoneyError) {
    error = new AppError('VALIDATION_FAILED', error.message);
  }
  if (isAppError(error)) {
    const body: ErrorBody = {
      code: error.code,
      message: error.message,
      correlationId,
      ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
    };
    return NextResponse.json(body, { status: error.status });
  }
  // An unexpected error returns nothing about itself. The detail stays server-side.
  console.error(`[${correlationId}]`, error);
  return NextResponse.json(
    { code: 'INTERNAL', message: 'something went wrong', correlationId } satisfies ErrorBody,
    { status: 500 },
  );
}

/**
 * A state-changing request must come from an origin we serve. SameSite cookies
 * are a defence, not THE defence: a browser that omits or mishandles them must
 * still not be able to drive a payment from another site.
 */
export function assertSameOrigin(req: NextRequest): void {
  // On Vercel the deployment's own URLs are allowed automatically; any custom
  // domain is added through ALLOWED_ORIGINS.
  const vercel = [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL]
    .filter(Boolean)
    .map((h) => `https://${h}`);
  const allowed = [...(process.env.ALLOWED_ORIGINS ?? 'http://localhost:3000').split(','), ...vercel]
    .map((o) => o.trim())
    .filter(Boolean);
  const origin = req.headers.get('origin');
  if (!origin) {
    // No Origin header on a mutation: refuse rather than guess. Browsers send it
    // on every cross-origin state change, and our own client always sends it.
    throw new AppError('VALIDATION_FAILED', 'missing origin');
  }
  if (!allowed.includes(origin)) {
    throw new AppError('VALIDATION_FAILED', 'origin not allowed');
  }
}

export async function requireSession(req: NextRequest): Promise<ResolvedSession> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  return resolveSession(getDb(), token);
}

/** Parses a JSON body against a schema, with a bounded size and no extra keys. */
export async function parseBody<T extends z.ZodTypeAny>(
  req: NextRequest,
  schema: T,
): Promise<z.infer<T>> {
  const raw = await req.text();
  if (raw.length > 32_768) throw new AppError('VALIDATION_FAILED', 'request body too large');
  let json: unknown;
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    throw new AppError('VALIDATION_FAILED', 'body is not valid JSON');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[issue.path.join('.') || '_'] = issue.message;
    }
    throw new AppError('VALIDATION_FAILED', 'invalid request', fieldErrors);
  }
  return parsed.data;
}

/** Amounts leave the server as decimal strings, never as JSON numbers. */
export function json(data: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json(
    JSON.parse(JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))),
    init,
  );
}

export const uuid = z.string().uuid();

/**
 * Fixed-window limiter backed by Postgres, so every server instance shares one
 * count. One upsert per call.
 * ponytail: fixed window allows up to 2x the limit across a window edge; a
 * sliding window or a token bucket in Redis if that ever matters.
 */
export async function rateLimit(key: string, limit: number, windowMs: number): Promise<void> {
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  const { rows } = await getPool().query<{ count: number }>(
    `INSERT INTO rate_limits (key, window_start, count) VALUES ($1, $2, 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count`,
    [key, windowStart],
  );
  // Old windows are dead weight; sweep now and then rather than on every call.
  if (Math.random() < 0.01) await getPool().query('DELETE FROM rate_limits WHERE window_start < $1', [Date.now() - 86_400_000]);
  if (rows[0]!.count > limit) throw new AppError('RATE_LIMITED', 'too many requests');
}

export function clientKey(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
}

/** True only for a local demo deployment. Guards the scenario-control routes. */
export function demoControlsEnabled(): boolean {
  return (process.env.APP_ENV ?? 'local_demo') !== 'hosted_demo';
}

/**
 * The pre-wallet demo endpoints (anonymous scenario sessions and the transfer
 * simulator) exist for the test suite and local runs. On the hosted site an
 * anonymous session would be an account nobody signed up for, so they are absent.
 */
export function assertLegacyDemoEnabled(): void {
  if (!demoControlsEnabled()) throw new AppError('NOT_FOUND', 'not found');
}
