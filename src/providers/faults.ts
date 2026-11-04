// Deterministic fault engine for the mock providers (ADR-0008). Count-based triggers only:
// no wall clock, no randomness. One engine instance per provider process.
import { z } from 'zod';
import { ENTITY_ID } from './ids.ts';

export const FAULT_MODES = [
  'NORMAL',
  'TIMEOUT_BEFORE_WRITE',
  'TIMEOUT_AFTER_WRITE',
  'PERMANENT_REJECTION',
  'SLOW_CONSISTENCY',
  'CONCURRENT_STATUS_CHANGE',
  'DUPLICATE_DELIVERY',
  'UNAVAILABLE_STATUS_QUERY',
] as const;
export type FaultMode = (typeof FAULT_MODES)[number];

/** Hook points where a rule can fire. */
export const OPERATIONS = ['read', 'mutation', 'status_query'] as const;
export type Operation = (typeof OPERATIONS)[number];

export type ProviderKind = 'order' | 'carrier';

/** Which operations each fault may attach to, per provider. NORMAL is "no rules". */
const ALLOWED_OPS: Record<ProviderKind, Partial<Record<FaultMode, readonly Operation[]>>> = {
  order: {
    TIMEOUT_BEFORE_WRITE: ['mutation', 'read', 'status_query'],
    TIMEOUT_AFTER_WRITE: ['mutation'],
    PERMANENT_REJECTION: ['mutation'],
    SLOW_CONSISTENCY: ['mutation'],
    CONCURRENT_STATUS_CHANGE: ['read'],
    DUPLICATE_DELIVERY: ['mutation'],
    UNAVAILABLE_STATUS_QUERY: ['status_query', 'read'],
  },
  carrier: {
    TIMEOUT_BEFORE_WRITE: ['mutation', 'read', 'status_query'],
    TIMEOUT_AFTER_WRITE: ['mutation'],
    PERMANENT_REJECTION: ['mutation'],
    SLOW_CONSISTENCY: ['mutation'],
    CONCURRENT_STATUS_CHANGE: ['mutation'],
    DUPLICATE_DELIVERY: ['mutation'],
    UNAVAILABLE_STATUS_QUERY: ['status_query', 'read'],
  },
};


const RuleSchema = z.strictObject({
  fault: z.enum(FAULT_MODES).exclude(['NORMAL']),
  /** Entity id (ord_… / shp_…) or "*" for any entity. */
  target: z.union([z.literal('*'), z.string().regex(ENTITY_ID)]),
  /** Defaults to the first allowed operation for the fault on this provider. */
  on: z.enum(OPERATIONS).optional(),
  /** Skip this many matching operations before firing. */
  after: z.number().int().min(0).max(1000).default(0),
  /** Fire this many times; null = every matching operation. */
  times: z.number().int().min(1).max(1000).nullable().default(1),
  params: z
    .strictObject({
      manifest: z.enum(['hang', 'reset']).optional(),
      hang_ms: z.number().int().min(1).max(60_000).optional(),
      stale_reads: z.number().int().min(1).max(100).optional(),
    })
    .default({}),
});

export const ScenarioConfigSchema = z.strictObject({
  scenario_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  honour_idempotency_keys: z.boolean().default(true),
  rules: z.array(RuleSchema).max(20).default([]),
});
export type ScenarioConfigInput = z.input<typeof ScenarioConfigSchema>;

export interface FaultRule {
  fault: Exclude<FaultMode, 'NORMAL'>;
  target: string;
  on: Operation;
  after: number;
  times: number | null;
  params: { manifest: 'hang' | 'reset'; hang_ms: number; stale_reads: number };
}

interface RuleState {
  rule: FaultRule;
  matched: number;
  fired: number;
}

const DEFAULT_PARAMS = { manifest: 'hang', hang_ms: 1000, stale_reads: 2 } as const;

export class FaultConfigError extends Error {
  readonly details: { path: string; message: string }[];
  constructor(details: { path: string; message: string }[]) {
    super('scenario config is invalid');
    this.name = 'FaultConfigError';
    this.details = details;
  }
}

/** Parses and resolves defaults; throws FaultConfigError on any invalid rule. */
export function parseScenarioConfig(kind: ProviderKind, input: unknown) {
  const parsed = ScenarioConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new FaultConfigError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })));
  }
  const rules: FaultRule[] = [];
  const errors: { path: string; message: string }[] = [];
  parsed.data.rules.forEach((r, i) => {
    const allowed = ALLOWED_OPS[kind][r.fault] ?? [];
    const on = r.on ?? allowed[0];
    if (!on || !allowed.includes(on)) {
      errors.push({ path: `rules.${i}.on`, message: `${r.fault} cannot attach to "${r.on}" on the ${kind} provider (allowed: ${allowed.join(', ')})` });
      return;
    }
    rules.push({ fault: r.fault, target: r.target, on, after: r.after, times: r.times, params: { ...DEFAULT_PARAMS, ...r.params } });
  });
  if (errors.length) throw new FaultConfigError(errors);
  return { scenarioId: parsed.data.scenario_id, honourIdempotencyKeys: parsed.data.honour_idempotency_keys, rules };
}

export class FaultEngine<Snapshot> {
  readonly kind: ProviderKind;
  private scenarioId = 'NORMAL';
  private honour = true;
  private rules: RuleState[] = [];
  private readonly stale = new Map<string, { snapshot: Snapshot; remaining: number }>();

  constructor(kind: ProviderKind) {
    this.kind = kind;
  }

  load(input: unknown): void {
    const config = parseScenarioConfig(this.kind, input);
    this.scenarioId = config.scenarioId;
    this.honour = config.honourIdempotencyKeys;
    this.rules = config.rules.map((rule) => ({ rule, matched: 0, fired: 0 }));
    this.stale.clear();
  }

  reset(): void {
    this.load({ scenario_id: 'NORMAL' });
  }

  get honoursIdempotencyKeys(): boolean {
    return this.honour;
  }

  /** Returns the rules that fire for this operation, advancing their counters. */
  fire(op: Operation, entityId: string): FaultRule[] {
    const firing: FaultRule[] = [];
    for (const state of this.rules) {
      const { rule } = state;
      if (rule.on !== op || (rule.target !== '*' && rule.target !== entityId)) continue;
      state.matched++;
      if (state.matched > rule.after && (rule.times === null || state.fired < rule.times)) {
        state.fired++;
        firing.push(rule);
      }
    }
    return firing;
  }

  markStale(entityId: string, snapshot: Snapshot, reads: number): void {
    this.stale.set(entityId, { snapshot, remaining: reads });
  }

  /** Returns a stale snapshot if one is pending for this entity, consuming one stale read. */
  takeStale(entityId: string): Snapshot | undefined {
    const entry = this.stale.get(entityId);
    if (!entry) return undefined;
    entry.remaining--;
    if (entry.remaining <= 0) this.stale.delete(entityId);
    return entry.snapshot;
  }

  state() {
    return {
      provider: this.kind,
      scenario_id: this.scenarioId,
      honour_idempotency_keys: this.honour,
      rules: this.rules.map(({ rule, matched, fired }) => ({ ...rule, matched, fired })),
    };
  }
}
