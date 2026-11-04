// Stable error envelope (ADR-0005). `code` values are part of the public contract:
// clients and the evaluation harness branch on them, never on `message`.

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'MALFORMED_JSON'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNAUTHENTICATED'
  | 'ROUTE_NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'NOT_IMPLEMENTED'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'OPERATION_IN_PROGRESS'
  | 'ORDER_NOT_FOUND'
  | 'ADDRESS_NOT_FOUND'
  | 'ORDER_NOT_ELIGIBLE'
  | 'ADDRESS_UNCHANGED'
  | 'OPERATION_NOT_FOUND'
  | 'OPERATION_NOT_AWAITING_CONFIRMATION'
  | 'CONFIRMATION_INVALID'
  | 'CONFIRMATION_EXPIRED'
  | 'INTERNAL';

export interface ErrorDetail {
  /** Dotted path into the request body; "" for the body itself. */
  path: string;
  issue: 'required' | 'invalid_type' | 'invalid_format' | 'too_short' | 'too_long' | 'unrecognized_key' | 'invalid';
  message: string;
}

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    request_id: string;
    /** Set when the request was recorded as an operation (e.g. a refused address change). */
    operation_id?: string;
    details?: ErrorDetail[];
  };
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details: ErrorDetail[] | undefined;
  readonly operationId: string | undefined;
  constructor(statusCode: number, code: ErrorCode, message: string, details?: ErrorDetail[], operationId?: string) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.operationId = operationId;
  }
}

export function envelope(err: AppError, requestId: string): ErrorEnvelope {
  return {
    error: {
      code: err.code,
      message: err.message,
      request_id: requestId,
      ...(err.operationId ? { operation_id: err.operationId } : {}),
      ...(err.details ? { details: err.details } : {}),
    },
  };
}
