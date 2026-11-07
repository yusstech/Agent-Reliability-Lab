// NAIVE: a no-model negative control (Phase 05). A scripted policy behind the ModelClient
// interface, so it runs through the identical loop, tools, trace, runner and scorer as the
// model variants. It is the integration everyone writes first and nobody should ship:
//   - no confirmation, no reads, no idempotency key, no expected_version;
//   - it trusts acknowledgements, and treats a timeout as "sent" (optimistic);
//   - order first, then carrier; any refusal ends the attempt with not_changed;
//   - no verification and no compensation.
// It is a control for the HARNESS, not evidence about agents: its outputs must never be
// reported as model behaviour (roadmap Phase 05: "do not substitute simulated model output").
import type Anthropic from '@anthropic-ai/sdk';
import type { ModelClient } from './loop.ts';

export const NAIVE_MODEL_ID = 'naive-v1';

type Result = { outcome: string };

function lastToolResults(messages: Anthropic.MessageParam[]): Result[] {
  const last = messages.at(-1);
  if (!last || last.role !== 'user' || typeof last.content === 'string') return [];
  return last.content.filter((b): b is Anthropic.ToolResultBlockParam => b.type === 'tool_result').map((b) => JSON.parse(String(b.content)) as Result);
}

function message(id: string, content: Anthropic.ContentBlock[]): Anthropic.Message {
  return {
    id,
    type: 'message',
    role: 'assistant',
    model: NAIVE_MODEL_ID,
    content,
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  } as unknown as Anthropic.Message;
}

const call = (n: number, name: string, input: Record<string, unknown>): Anthropic.ToolUseBlock => ({ type: 'tool_use', id: `toolu_naive_${n}`, name, input }) as Anthropic.ToolUseBlock;

/** Reads the structured request the runner sends ("order ord_X ... saved address addr_Y"). */
export function parseRequest(text: string): { order_id: string; address_id: string } {
  const order = text.match(/\bord_[a-z0-9]{1,32}\b/)?.[0];
  const address = text.match(/\baddr_[a-z0-9]{1,32}\b/)?.[0];
  if (!order || !address) throw new Error('naive policy could not parse the request');
  return { order_id: order, address_id: address };
}

export function createNaiveClient(): ModelClient {
  return {
    model: NAIVE_MODEL_ID,
    paid: false,
    async create(params) {
      const first = params.messages[0];
      const text = typeof first?.content === 'string' ? first.content : '';
      const req = parseRequest(text);
      const step = (params.messages.length - 1) / 2; // 0, 1, 2: turns completed so far
      const args = { order_id: req.order_id, address_id: req.address_id, idempotency_key: null, expected_version: null };
      const sent = (r: Result | undefined) => r?.outcome === 'ok' || r?.outcome === 'unknown';
      const report = (status: string, msg: string) => message(`msg_naive_${step}`, [call(step, 'report_to_customer', { status, message: msg })]);

      if (step === 0) return message('msg_naive_0', [call(0, 'change_order_address', args)]);
      const [last] = lastToolResults(params.messages);
      if (step === 1) return sent(last) ? message('msg_naive_1', [call(1, 'change_shipment_address', args)]) : report('not_changed', 'We could not change the delivery address.');
      return sent(last) ? report('completed', 'Your delivery address has been updated.') : report('not_changed', 'We could not change the delivery address.');
    },
  };
}
