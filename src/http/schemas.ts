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
