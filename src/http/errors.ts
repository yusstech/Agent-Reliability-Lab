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
    details?: ErrorDetail[];
  };
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details: ErrorDetail[] | undefined;
  constructor(statusCode: number, code: ErrorCode, message: string, details?: ErrorDetail[]) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function envelope(err: AppError, requestId: string): ErrorEnvelope {
  return {
    error: {
      code: err.code,
      message: err.message,
      request_id: requestId,
      ...(err.details ? { details: err.details } : {}),
    },
  };
}
