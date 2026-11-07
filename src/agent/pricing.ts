// Model ids and prices (ADR-0007). Pure: the scorer imports this without loading the SDK.

export const MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5'] as const;
export type ModelId = (typeof MODELS)[number];

/** USD per million tokens. Source: Anthropic API reference, cached 2026-10-06 (ADR-0007). Re-check before the confirmatory run. */
export const PRICES: Record<ModelId, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  'claude-sonnet-5-5': { input: 2.0, output: 10.0, cacheWrite: 2.5, cacheRead: 0.2 },
};

/** ADR-0007 hard cap for the whole study. A run's budget may be lower, never higher. */
export const STUDY_CAP_USD = 175;

export interface Usage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}

export function costUsd(model: string, u: Usage): number {
  const p = PRICES[model as ModelId];
  if (!p) return 0;
  return (u.input_tokens * p.input + u.cache_creation_input_tokens * p.cacheWrite + u.cache_read_input_tokens * p.cacheRead + u.output_tokens * p.output) / 1e6;
}
