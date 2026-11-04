import { expect, it } from 'vitest';
import { isEligibleForAddressChange } from '../../src/domain/order-eligibility.ts';
import { ORDER_STATUSES } from '../../src/domain/types.ts';

it('EL-01 only PLACED and PACKING orders are eligible', () => {
  const eligible = ORDER_STATUSES.filter(isEligibleForAddressChange);
  expect(eligible).toEqual(['PLACED', 'PACKING']);
});
