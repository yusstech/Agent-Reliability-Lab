// Representative variant A scenarios for Phase 03 evidence: the whole request →
// confirmation → worker → verification path under one provider fault each.
import type { FaultMode, ScenarioConfigInput } from '../src/providers/faults.ts';
import type { CrashPoint } from '../src/workflow/worker.ts';

type ProviderConfig = Omit<ScenarioConfigInput, 'scenario_id'>;

export interface WorkflowScenario {
  id: string;
  fault: FaultMode | 'WORKER_CRASH';
  title: string;
  order?: ProviderConfig;
  carrier?: ProviderConfig;
  /** Kill the first worker at this point while the order write is in flight. */
  crashAt?: CrashPoint;
}

const HANG = { hang_ms: 1500 } as const;

export const WORKFLOW_SCENARIOS: WorkflowScenario[] = [
  { id: 'P03-01', fault: 'NORMAL', title: 'No faults' },
  { id: 'P03-02', fault: 'TIMEOUT_BEFORE_WRITE', title: 'Order times out before writing (keys honoured)', order: { rules: [{ fault: 'TIMEOUT_BEFORE_WRITE', target: '*', params: HANG }] } },
  { id: 'P03-03', fault: 'TIMEOUT_AFTER_WRITE', title: 'Order writes, then times out (keys honoured)', order: { rules: [{ fault: 'TIMEOUT_AFTER_WRITE', target: '*', params: HANG }] } },
  {
    id: 'P03-04', fault: 'TIMEOUT_AFTER_WRITE', title: 'Order writes, then times out; providers ignore keys',
    order: { honour_idempotency_keys: false, rules: [{ fault: 'TIMEOUT_AFTER_WRITE', target: '*', params: HANG }] },
    carrier: { honour_idempotency_keys: false },
  },
  { id: 'P03-05', fault: 'PERMANENT_REJECTION', title: 'Carrier rejects after the order changed: compensation', carrier: { rules: [{ fault: 'PERMANENT_REJECTION', target: '*' }] } },
  { id: 'P03-06', fault: 'CONCURRENT_STATUS_CHANGE', title: 'Order ships between validation and write', order: { rules: [{ fault: 'CONCURRENT_STATUS_CHANGE', target: '*', after: 1 }] } },
  { id: 'P03-07', fault: 'SLOW_CONSISTENCY', title: 'Carrier read is stale after the write', carrier: { rules: [{ fault: 'SLOW_CONSISTENCY', target: '*', params: { stale_reads: 2 } }] } },
  { id: 'P03-08', fault: 'DUPLICATE_DELIVERY', title: 'Order request duplicated in transit; keys ignored', order: { honour_idempotency_keys: false, rules: [{ fault: 'DUPLICATE_DELIVERY', target: '*' }] } },
  {
    id: 'P03-09', fault: 'UNAVAILABLE_STATUS_QUERY', title: 'Write landed; status and reads then unavailable',
    order: {
      rules: [
        { fault: 'TIMEOUT_AFTER_WRITE', target: '*', params: HANG },
        { fault: 'UNAVAILABLE_STATUS_QUERY', target: '*', on: 'status_query', times: null },
        { fault: 'UNAVAILABLE_STATUS_QUERY', target: '*', on: 'read', after: 2, times: null },
      ],
    },
  },
  { id: 'P03-10', fault: 'WORKER_CRASH', title: 'Worker dies right after the order write; a second worker recovers', crashAt: 'after_provider_write' },
];
