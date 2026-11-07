// Tool trace for model-directed variants (ADR-0011). Every entry is written by trusted
// code at the moment a tool acts, never derived from model text. The scorer's procedure
// and invariant detectors for B-family records read this trace (EVALUATION_DEVIATIONS #2).

export type ProviderName = 'order' | 'carrier';

export type TraceKind =
  /** The request reached an agent (episode start). The B analogue of A's RECEIVED. */
  | 'received'
  /** A read of one provider entity (by the model's tool call, or by a guard/verifier in code). */
  | 'read'
  /** An address-change request. `dispatched` is false when code refused it before sending. */
  | 'write'
  /** A lookup of a write by idempotency key. */
  | 'status_query'
  /** A confirmation question put to the customer, and the customer's answer. */
  | 'consent'
  /** A `report_to_customer` call. `accepted` is false when the B3 tool refused it. */
  | 'report'
  /** A read of the customer's saved addresses (identity store, no provider involved). */
  | 'list_addresses'
  /** A scripted event from the case (another actor, a competing request). */
  | 'world';

export interface TraceEvent {
  /** Global order within the case-run. */
  seq: number;
  /** The customer request this event belongs to (the B analogue of an operation). */
  request_id: string;
  /** Episode index within the case-run (several episodes may serve one request). */
  episode: number;
  /** Model turn (1-based) whose tool call caused this; 0 for events outside any turn. */
  turn: number;
  /** Who acted: the model via a tool, code inside a tool (guard or verifier), the customer, or the world. */
  actor: 'model' | 'code' | 'customer' | 'world';
  kind: TraceKind;
  tool: string | null;
  provider: ProviderName | null;
  /** Address involved: the write's target, the confirmation's address, the report's request target. */
  address_id: string | null;
  order_id: string | null;
  /** ok | rejected | unknown (provider outcome); refused (blocked by code); confirmed | declined (consent). */
  result: 'ok' | 'rejected' | 'unknown' | 'refused' | 'confirmed' | 'declined' | 'accepted';
  code: string | null;
  dispatched: boolean;
  /** For writes: the idempotency key and expected_version actually sent (null if none). */
  key: string | null;
  expected_version: number | null;
  /** For reads: what the provider returned. */
  entity: { address_id: string; version: number; status: string } | null;
  /** For reports: the status argument. */
  status: string | null;
  at: string;
}

export class TraceRecorder {
  readonly events: TraceEvent[] = [];
  private seq = 0;

  record(e: Omit<TraceEvent, 'seq' | 'at'>): TraceEvent {
    const full = { ...e, seq: ++this.seq, at: new Date().toISOString() };
    this.events.push(full);
    return full;
  }
}
