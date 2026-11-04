import { z } from 'zod';
import { AppError, type ErrorDetail } from './errors.ts';

// Spec §7. Strict: unknown keys are rejected, so a client (or model) cannot smuggle
// `customer_id`, `confirmed` or similar trust-bearing fields into the request.
export const AddressChangeRequestSchema = z.strictObject({
  order_id: z.string().regex(/^ord_[a-z0-9]{1,32}$/, 'must look like ord_<id>'),
  new_address_id: z.string().regex(/^addr_[a-z0-9]{1,32}$/, 'must look like addr_<id>'),
  message: z.string().max(1000).optional(),
  idempotency_key: z
    .string()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/, 'may contain only letters, digits, "_" and "-"'),
});
export type AddressChangeRequest = z.infer<typeof AddressChangeRequestSchema>;

/** Consent is a server-issued token, never a boolean (ADR-0009 §9). */
export const ConfirmBodySchema = z.strictObject({
  confirmation_token: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'must be the token issued with the request'),
});

export const OperationParamsSchema = z.strictObject({
  id: z.string().regex(/^op_[a-z0-9]{1,40}$/, 'must look like op_<id>'),
});

export const InterpretBodySchema = z.strictObject({
  message: z.string().min(1).max(1000),
});

function toDetails(error: z.ZodError, input: unknown): ErrorDetail[] {
  const details: ErrorDetail[] = [];
  for (const issue of error.issues) {
    const path = issue.path.map(String).join('.');
    switch (issue.code) {
      case 'unrecognized_keys':
        for (const key of issue.keys) {
          details.push({ path: path ? `${path}.${key}` : key, issue: 'unrecognized_key', message: 'field is not accepted' });
        }
        break;
      case 'invalid_type': {
        const missing =
          issue.path.length === 1 && typeof input === 'object' && input !== null && !(String(issue.path[0]) in input);
        details.push(
          missing
            ? { path, issue: 'required', message: 'field is required' }
            : { path, issue: 'invalid_type', message: `expected ${issue.expected}` },
        );
        break;
      }
      case 'invalid_format':
        details.push({ path, issue: 'invalid_format', message: issue.message });
        break;
      case 'too_small':
        details.push({ path, issue: 'too_short', message: issue.message });
        break;
      case 'too_big':
        details.push({ path, issue: 'too_long', message: issue.message });
        break;
      default:
        details.push({ path, issue: 'invalid', message: issue.message });
    }
  }
  // Deterministic order regardless of validator internals.
  return details.sort((a, b) => a.path.localeCompare(b.path) || a.issue.localeCompare(b.issue));
}

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new AppError(400, 'VALIDATION_FAILED', 'request body is invalid', toDetails(result.error, body));
  }
  return result.data;
}
