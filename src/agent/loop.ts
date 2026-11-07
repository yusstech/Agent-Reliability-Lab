// The one hand-written tool-use loop (ADR-0007): identical for every rung and model.
// Append-only history, hard turn cap, per-turn usage logged, refusals recorded as an
// outcome and never retried or served by another model.
import type Anthropic from '@anthropic-ai/sdk';
import type { ReportedStatus, ToolLayer } from './tools.ts';

/** Anything that answers a Messages API request: the Anthropic client, or a scripted policy. */
export interface ModelClient {
  /** Model id recorded in traces (e.g. claude-haiku-5-5, or naive-v1 for the scripted control). */
  readonly model: string;
  /** True when calls cost money; such a client exists only behind the paid-call gate. */
  readonly paid: boolean;
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

export const LOOP = {
  maxTurns: 12,
  maxTokens: 8192,
  effort: 'medium',
} as const;

export type EpisodeOutcome =
  | 'reported'
  /** The model ended its turn without calling report_to_customer: a protocol failure (Plan §4.1). */
  | 'no_report'
  | 'turn_cap'
  | 'max_tokens'
  | 'model_refusal'
  | 'deadline'
  | 'api_error';

export interface TurnLog {
  turn: number;
  stop_reason: string | null;
  stop_details: unknown;
  usage: { input_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number; output_tokens: number };
  /** Assistant content as logged: thinking signatures dropped (they are opaque and large). */
  content: unknown[];
  tool_results: { tool_use_id: string; name: string; is_error: boolean; content: string }[];
  ms: number;
}

export interface EpisodeLog {
  episode: number;
  request_id: string;
  role: 'primary' | 'duplicate' | 'competing';
  model: string;
  outcome: EpisodeOutcome;
  reported: ReportedStatus | null;
  /** The customer-facing message of the accepted report. */
  message: string | null;
  error: string | null;
  turns: TurnLog[];
}

export interface EpisodeSpec {
  episode: number;
  request_id: string;
  role: EpisodeLog['role'];
  system: Anthropic.TextBlockParam[];
  tools: Anthropic.Tool[];
  userMessage: string;
  /** Wall-clock deadline (ms since epoch) shared by the case-run. */
  deadline: number;
}

const loggable = (blocks: Anthropic.ContentBlock[]) =>
  blocks.map((b) => (b.type === 'thinking' ? { type: 'thinking', thinking: b.thinking } : b.type === 'redacted_thinking' ? { type: 'redacted_thinking' } : b));

export function requestParams(model: string, spec: Pick<EpisodeSpec, 'system' | 'tools'>, messages: Anthropic.MessageParam[]): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: LOOP.maxTokens,
    system: spec.system,
    tools: spec.tools,
    tool_choice: { type: 'auto' },
    output_config: { effort: LOOP.effort },
    // thinking omitted: adaptive by default on both models (ADR-0007). No `fallbacks`:
    // refusal fallbacks stay off so a refusal is an outcome, never another model's answer.
    messages,
  };
}

export async function runEpisode(client: ModelClient, tools: ToolLayer, spec: EpisodeSpec): Promise<EpisodeLog> {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: spec.userMessage }];
  const log: EpisodeLog = { episode: spec.episode, request_id: spec.request_id, role: spec.role, model: client.model, outcome: 'turn_cap', reported: null, message: null, error: null, turns: [] };

  for (let turn = 1; turn <= LOOP.maxTurns; turn++) {
    if (Date.now() > spec.deadline) {
      log.outcome = 'deadline';
      return log;
    }
    const started = Date.now();
    let response: Anthropic.Message;
    try {
      response = await client.create(requestParams(client.model, spec, messages));
    } catch (err) {
      // A budget stop or a closed paid-call gate halts the whole run; it is not an episode outcome.
      if ((err as Error).name === 'BudgetExceededError' || (err as Error).name === 'PaidCallsNotAllowedError') throw err;
      log.outcome = 'api_error';
      log.error = `${(err as Error).name}: ${(err as Error).message}`.slice(0, 500);
      return log;
    }
    const u = response.usage;
    const entry: TurnLog = {
      turn,
      stop_reason: response.stop_reason,
      stop_details: (response as { stop_details?: unknown }).stop_details ?? null,
      usage: { input_tokens: u.input_tokens, cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0, cache_read_input_tokens: u.cache_read_input_tokens ?? 0, output_tokens: u.output_tokens },
      content: loggable(response.content),
      tool_results: [],
      ms: 0,
    };
    log.turns.push(entry);
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'refusal') {
      log.outcome = 'model_refusal';
      entry.ms = Date.now() - started;
      return log;
    }
    if (response.stop_reason === 'max_tokens') {
      log.outcome = 'max_tokens';
      entry.ms = Date.now() - started;
      return log;
    }
    const calls = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (calls.length === 0) {
      log.outcome = 'no_report';
      entry.ms = Date.now() - started;
      return log;
    }

    // Parallel calls in one turn run in the order given; all results go back in one message.
    tools.setTurn(turn);
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of calls) {
      const out = await tools.call(call.name, call.input);
      results.push({ type: 'tool_result', tool_use_id: call.id, content: out.content, ...(out.isError ? { is_error: true } : {}) });
      entry.tool_results.push({ tool_use_id: call.id, name: call.name, is_error: out.isError, content: out.content });
      if (out.reported && log.reported === null) {
        log.reported = out.reported;
        log.message = (call.input as { message?: string }).message ?? null;
      }
    }
    entry.ms = Date.now() - started;
    if (log.reported !== null) {
      log.outcome = 'reported';
      return log;
    }
    messages.push({ role: 'user', content: results });
  }
  return log;
}
