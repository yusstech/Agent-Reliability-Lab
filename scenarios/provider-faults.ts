// Named Phase 02 scenarios: one or more per fault mode (ADR-0008). Each runs the same
// probe sequence against the real provider HTTP APIs; see src/providers/trace.ts.
import type { FaultMode, ScenarioConfigInput } from '../src/providers/faults.ts';

type ProviderConfig = Omit<ScenarioConfigInput, 'scenario_id'>;

export interface Probe {
  provider: 'order' | 'carrier';
  /** Send the version read in step 1 as expected_version (optimistic concurrency). */
  expectedVersion: boolean;
}

export interface ProviderScenario {
  id: string;
  fault: FaultMode;
  title: string;
  order?: ProviderConfig;
  carrier?: ProviderConfig;
  probes: Probe[];
}

const HANG = { hang_ms: 1000 } as const;

export const PROVIDER_SCENARIOS: ProviderScenario[] = [
  { id: 'P02-01', fault: 'NORMAL', title: 'No faults', probes: [{ provider: 'order', expectedVersion: true }] },
  {
    id: 'P02-02', fault: 'TIMEOUT_BEFORE_WRITE', title: 'Order times out before writing (keys honoured)',
    order: { rules: [{ fault: 'TIMEOUT_BEFORE_WRITE', target: '*', params: HANG }] },
    probes: [{ provider: 'order', expectedVersion: true }],
  },
  {
    id: 'P02-03', fault: 'TIMEOUT_AFTER_WRITE', title: 'Order writes, then times out (keys honoured)',
    order: { rules: [{ fault: 'TIMEOUT_AFTER_WRITE', target: '*', params: HANG }] },
    probes: [{ provider: 'order', expectedVersion: true }],
  },
  {
    id: 'P02-04', fault: 'TIMEOUT_AFTER_WRITE', title: 'Order writes, then times out; keys ignored; retry without expected_version',
    order: { honour_idempotency_keys: false, rules: [{ fault: 'TIMEOUT_AFTER_WRITE', target: '*', params: HANG }] },
    probes: [{ provider: 'order', expectedVersion: false }],
  },
  {
    id: 'P02-05', fault: 'TIMEOUT_AFTER_WRITE', title: 'Order writes, then times out; keys ignored; retry with expected_version',
    order: { honour_idempotency_keys: false, rules: [{ fault: 'TIMEOUT_AFTER_WRITE', target: '*', params: HANG }] },
    probes: [{ provider: 'order', expectedVersion: true }],
  },
  {
    id: 'P02-06', fault: 'PERMANENT_REJECTION', title: 'Carrier permanently rejects the change',
    carrier: { rules: [{ fault: 'PERMANENT_REJECTION', target: '*' }] },
    probes: [{ provider: 'carrier', expectedVersion: true }],
  },
  {
    id: 'P02-07', fault: 'SLOW_CONSISTENCY', title: 'Carrier accepts; the next read is stale',
    carrier: { rules: [{ fault: 'SLOW_CONSISTENCY', target: '*', params: { stale_reads: 1 } }] },
    probes: [{ provider: 'carrier', expectedVersion: true }],
  },
  {
    id: 'P02-08', fault: 'CONCURRENT_STATUS_CHANGE', title: 'Order ships after it is read; shipment is dispatched before the carrier write',
    order: { rules: [{ fault: 'CONCURRENT_STATUS_CHANGE', target: '*' }] },
    carrier: { rules: [{ fault: 'CONCURRENT_STATUS_CHANGE', target: '*' }] },
    probes: [{ provider: 'order', expectedVersion: true }, { provider: 'carrier', expectedVersion: true }],
  },
  {
    id: 'P02-09', fault: 'DUPLICATE_DELIVERY', title: 'Order request duplicated in transit (keys honoured)',
    order: { rules: [{ fault: 'DUPLICATE_DELIVERY', target: '*' }] },
    probes: [{ provider: 'order', expectedVersion: false }],
  },
  {
    id: 'P02-10', fault: 'DUPLICATE_DELIVERY', title: 'Order request duplicated in transit (keys ignored)',
    order: { honour_idempotency_keys: false, rules: [{ fault: 'DUPLICATE_DELIVERY', target: '*' }] },
    probes: [{ provider: 'order', expectedVersion: false }],
  },
  {
    id: 'P02-11', fault: 'UNAVAILABLE_STATUS_QUERY', title: 'Order writes and times out; its status endpoint is down',
    order: {
      rules: [
        { fault: 'TIMEOUT_AFTER_WRITE', target: '*', params: HANG },
        { fault: 'UNAVAILABLE_STATUS_QUERY', target: '*', times: null },
      ],
    },
    probes: [{ provider: 'order', expectedVersion: true }],
  },
  {
    id: 'P02-12', fault: 'TIMEOUT_BEFORE_WRITE', title: 'Carrier resets the connection before writing',
    carrier: { rules: [{ fault: 'TIMEOUT_BEFORE_WRITE', target: '*', params: { manifest: 'reset' } }] },
    probes: [{ provider: 'carrier', expectedVersion: true }],
  },
];
