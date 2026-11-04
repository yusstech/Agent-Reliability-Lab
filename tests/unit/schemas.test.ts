import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/http/errors.ts';
import { AddressChangeRequestSchema, parseBody } from '../../src/http/schemas.ts';

const valid = { order_id: 'ord_1042', new_address_id: 'addr_72', message: 'office please', idempotency_key: 'req_73a8' };

function details(body: unknown) {
  try {
    parseBody(AddressChangeRequestSchema, body);
  } catch (err) {
    if (err instanceof AppError) return { code: err.code, details: err.details };
    throw err;
  }
  return null;
}

describe('address-change request validation', () => {
  it('VA-01 accepts the spec example', () => {
    expect(parseBody(AddressChangeRequestSchema, valid)).toEqual(valid);
  });

  it('VA-02 message is optional', () => {
    const { message: _omit, ...rest } = valid;
    expect(details(rest)).toBeNull();
  });

  it('VA-03 rejects trust-bearing fields such as customer_id and confirmed', () => {
    expect(details({ ...valid, customer_id: 'cus_002', confirmed: true })).toEqual({
      code: 'VALIDATION_FAILED',
      details: [
        { path: 'confirmed', issue: 'unrecognized_key', message: 'field is not accepted' },
        { path: 'customer_id', issue: 'unrecognized_key', message: 'field is not accepted' },
      ],
    });
  });

  it('VA-04 reports missing fields as required, in a stable order', () => {
    expect(details({})?.details?.map((d) => `${d.path}:${d.issue}`)).toEqual([
      'idempotency_key:required',
      'new_address_id:required',
      'order_id:required',
    ]);
  });

  it('VA-05 reports format, length and type problems', () => {
    const got = details({ order_id: 'ORDER-1', new_address_id: 72, idempotency_key: 'short' })?.details?.map((d) => `${d.path}:${d.issue}`);
    expect(got).toEqual(['idempotency_key:too_short', 'new_address_id:invalid_type', 'order_id:invalid_format']);
    expect(details({ ...valid, message: 'x'.repeat(1001) })?.details?.[0]?.issue).toBe('too_long');
  });

  it('VA-06 rejects non-object bodies', () => {
    for (const body of [null, [], 'text', 42]) {
      expect(details(body)).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ path: '', issue: 'invalid_type' }] });
    }
  });
});
