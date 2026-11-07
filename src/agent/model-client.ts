// The only path to a paid model call (ADR-0007). A client exists only when the operator
// passes an explicit allow flag and a budget; every call is metered against that budget
// and the run stops before a call that could cross it.
import Anthropic from '@anthropic-ai/sdk';
import type { ModelClient } from './loop.ts';
import { costUsd, MODELS, STUDY_CAP_USD, type Usage } from './pricing.ts';

export { MODELS, STUDY_CAP_USD } from './pricing.ts';

export class BudgetExceededError extends Error {
  constructor(spent: number, cap: number) {
    super(`budget stop: $${spent.toFixed(4)} spent of a $${cap.toFixed(2)} run budget; no further calls`);
    this.name = 'BudgetExceededError';
  }
}

export class PaidCallsNotAllowedError extends Error {
  constructor(why: string) {
    super(`paid model calls are not allowed: ${why}`);
    this.name = 'PaidCallsNotAllowedError';
  }
}

export class BudgetMeter {
  spent = 0;
  calls = 0;
  readonly cap: number;
  /** Headroom kept for one more call; no call starts unless this much budget remains. */
  readonly perCallReserve: number;

  constructor(cap: number, perCallReserve = 0.1) {
    this.cap = cap;
    this.perCallReserve = perCallReserve;
  }

  assertCanCall(): void {
    if (this.spent + this.perCallReserve > this.cap) throw new BudgetExceededError(this.spent, this.cap);
  }

  add(model: string, u: Usage): void {
    this.calls++;
    this.spent += costUsd(model, u);
  }
}

export interface PaidClientOptions {
  model: string;
  /** Must be true: set only by an explicit operator flag (--allow-paid). */
  allowPaid: boolean;
  budgetUsd: number;
  meter?: BudgetMeter;
}

/** Builds the Anthropic-backed client, refusing unless every gate is open. */
export function createPaidClient(o: PaidClientOptions): ModelClient & { meter: BudgetMeter } {
  if (!o.allowPaid) throw new PaidCallsNotAllowedError('pass --allow-paid after the maintainer approves the spend');
  if (!(MODELS as readonly string[]).includes(o.model)) throw new PaidCallsNotAllowedError(`model ${o.model} is not one of ${MODELS.join(', ')} (ADR-0007)`);
  if (!Number.isFinite(o.budgetUsd) || o.budgetUsd <= 0 || o.budgetUsd > STUDY_CAP_USD) throw new PaidCallsNotAllowedError(`--budget-usd must be in (0, ${STUDY_CAP_USD}]`);
  const meter = o.meter ?? new BudgetMeter(o.budgetUsd);
  // Credentials resolve the SDK's usual way (ANTHROPIC_API_KEY or an `ant auth login` profile); never logged.
  const sdk = new Anthropic({ maxRetries: 2 });
  return {
    model: o.model,
    paid: true,
    meter,
    async create(params) {
      meter.assertCanCall();
      const message = await sdk.messages.create(params);
      meter.add(o.model, {
        input_tokens: message.usage.input_tokens,
        cache_creation_input_tokens: message.usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: message.usage.cache_read_input_tokens ?? 0,
        output_tokens: message.usage.output_tokens,
      });
      return message;
    },
  };
}
