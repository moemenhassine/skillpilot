// Stable error codes and their exit codes (spec section 14.4).
export const EXIT_CODES = {
  INTERNAL_ERROR: 1,
  INVALID_ARGUMENT: 2,
  INVALID_SCHEMA: 2,
  SOURCE_UNAVAILABLE: 3,
  RATE_LIMITED: 3,
  POLICY_BLOCKED: 4,
  REVIEW_INCOMPLETE: 4,
  APPROVAL_REQUIRED: 5,
  APPROVAL_MISMATCH: 5,
  APPROVAL_DECLINED: 5,
  TARGET_CONFLICT: 6,
  PLAN_STALE: 6,
  PLAN_EXPIRED: 6,
  IO_ERROR: 7,
  MUTATION_LOCKED: 7,
  RECOVERY_REQUIRED: 7,
  CANCELLED: 130,
} as const;

export type ErrorCode = keyof typeof EXIT_CODES;

export interface ErrorObject {
  code: ErrorCode;
  message: string;
  nextAction: string;
  details?: Record<string, unknown>;
}

export class SkillpilotError extends Error {
  readonly code: ErrorCode;
  readonly nextAction: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, nextAction: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.nextAction = nextAction;
    this.details = details;
  }

  toObject(): ErrorObject {
    return {
      code: this.code,
      message: this.message,
      nextAction: this.nextAction,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

/** Converts any thrown value to a structured error; unknown errors are sanitized. */
export function toErrorObject(err: unknown): ErrorObject {
  if (err instanceof SkillpilotError) return err.toObject();
  return {
    code: "INTERNAL_ERROR",
    message: "An unexpected internal error occurred.",
    nextAction: "Rerun with --verbose and report the issue if it persists.",
  };
}
