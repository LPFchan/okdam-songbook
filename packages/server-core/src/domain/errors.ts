import type { ApiErrorCode } from "@songbook/shared";

export const domainErrorCodes = [
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "DUPLICATE_TJ_NUMBER",
  "VERSION_MISMATCH",
  "IDEMPOTENCY_MISMATCH",
  "VALIDATION_ERROR",
  "AI_NOT_CONFIGURED",
  "EXTERNAL_API_ERROR",
  "TJ_TIMEOUT",
  "TJ_BODY_TOO_LARGE",
  "TJ_RATE_LIMITED",
  "TJ_CIRCUIT_OPEN",
  "TJ_UPSTREAM_ERROR",
  "TJ_PARSER_ERROR"
] as const;

export type DomainErrorCode = typeof domainErrorCodes[number];

/**
 * The only translation boundary between domain errors and the shared wire
 * vocabulary. `satisfies` makes adding a domain code without choosing its
 * public API representation a compile-time error.
 */
export const domainErrorCodeToApiErrorCode = {
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  DUPLICATE_TJ_NUMBER: "DUPLICATE_TJ_NUMBER",
  VERSION_MISMATCH: "CONFLICT",
  IDEMPOTENCY_MISMATCH: "CONFLICT",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  AI_NOT_CONFIGURED: "AI_NOT_CONFIGURED",
  EXTERNAL_API_ERROR: "EXTERNAL_API_ERROR",
  TJ_TIMEOUT: "TJ_UPSTREAM_ERROR",
  TJ_BODY_TOO_LARGE: "TJ_UPSTREAM_ERROR",
  TJ_RATE_LIMITED: "TJ_RATE_LIMITED",
  TJ_CIRCUIT_OPEN: "TJ_UPSTREAM_ERROR",
  TJ_UPSTREAM_ERROR: "TJ_UPSTREAM_ERROR",
  TJ_PARSER_ERROR: "TJ_PARSER_ERROR"
} satisfies Record<DomainErrorCode, ApiErrorCode>;

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: unknown;

  constructor(code: DomainErrorCode, message: string, details: unknown = null) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

export interface ApiErrorMapping {
  code: ApiErrorCode;
  message: string;
  details: unknown;
}

/** Stable mapping for future HTTP and MCP adapters. */
export function toApiError(error: unknown): ApiErrorMapping {
  if (!(error instanceof DomainError)) return { code: "INTERNAL_ERROR", message: "요청을 처리하지 못했어.", details: null };
  const details = error.code === "VERSION_MISMATCH"
    ? { ...(error.details && typeof error.details === "object" ? error.details as Record<string, unknown> : {}), reason: "version-mismatch" }
    : error.code === "IDEMPOTENCY_MISMATCH"
      ? { ...(error.details && typeof error.details === "object" ? error.details as Record<string, unknown> : {}), reason: "idempotency-replay" }
      : error.details;
  return { code: domainErrorCodeToApiErrorCode[error.code], message: error.message, details };
}
