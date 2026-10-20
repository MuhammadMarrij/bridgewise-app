/**
 * The HTTP boundary: validation, session resolution, origin checking and a single
 * error envelope. Nothing past this layer trusts anything from the request.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../db/client';
import { AppError, isAppError } from '../services/errors';
import { SESSION_COOKIE, resolveSession, type ResolvedSession } from '../services/workspace';

export interface ErrorBody {
  code: string;
  message: string;
  correlationId: string;
  fieldErrors?: Record<string, string>;
}

export function fail(error: unknown, correlationId = randomUUID()): NextResponse {
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
  const allowed = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:3000')
    .split(',')
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
 * A crude in-process limiter. Enough to stop a public demo being used as a free
 * model endpoint; it is not a distributed rate limiter and the report says so.
 */
const hits = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, limit: number, windowMs: number): void {
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || entry.resetAt <= now) {
    hits.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  entry.count += 1;
  if (entry.count > limit) throw new AppError('RATE_LIMITED', 'too many requests');
}

export function clientKey(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
}

/** True only for a local demo deployment. Guards the scenario-control routes. */
export function demoControlsEnabled(): boolean {
  return (process.env.APP_ENV ?? 'local_demo') !== 'hosted_demo';
}
