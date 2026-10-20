/**
 * Typed domain errors. Every one maps to a safe client message and an HTTP status.
 * A raw database error, a stack trace or an internal identifier never reaches a
 * client or a model: those leak schema and existence information.
 */
export type AppErrorCode =
  | 'VALIDATION_FAILED'
  | 'NO_SESSION'
  | 'NOT_FOUND'
  | 'PLAN_NOT_APPROVED'
  | 'TERMS_CHANGED'
  | 'APPROVAL_EXPIRED'
  | 'APPROVAL_CONSUMED'
  | 'QUOTE_EXPIRED'
  | 'PLAN_CANCELLED'
  | 'INSUFFICIENT_FUNDS'
  | 'BREACHES_RESERVE'
  | 'OVERPAYS_OBLIGATION'
  | 'IDEMPOTENCY_CONFLICT'
  | 'ALREADY_EXECUTED'
  | 'EXECUTION_DISABLED'
  | 'UNSUPPORTED'
  | 'RATE_LIMITED'
  | 'DEPENDENCY_UNAVAILABLE';

const STATUS: Record<AppErrorCode, number> = {
  VALIDATION_FAILED: 422,
  NO_SESSION: 401,
  // A not-owned object answers exactly like an absent one, so a caller cannot
  // discover that another session's object exists.
  NOT_FOUND: 404,
  PLAN_NOT_APPROVED: 409,
  TERMS_CHANGED: 409,
  APPROVAL_EXPIRED: 409,
  APPROVAL_CONSUMED: 409,
  QUOTE_EXPIRED: 409,
  PLAN_CANCELLED: 409,
  INSUFFICIENT_FUNDS: 409,
  BREACHES_RESERVE: 409,
  OVERPAYS_OBLIGATION: 409,
  IDEMPOTENCY_CONFLICT: 409,
  ALREADY_EXECUTED: 409,
  EXECUTION_DISABLED: 503,
  UNSUPPORTED: 400,
  RATE_LIMITED: 429,
  DEPENDENCY_UNAVAILABLE: 503,
};

export class AppError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message: string,
    readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }

  get status(): number {
    return STATUS[this.code];
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
