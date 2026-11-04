// Variant A's language baseline (Evaluation Plan H4): deterministic rules that map a
// customer message to one typed proposal, a clarification, or a refusal. It never guesses:
// anything ambiguous becomes a clarification. Instructions embedded in the text have no
// effect because nothing here executes text.
import { isEligibleForAddressChange } from '../domain/order-eligibility.ts';
import type { Order, SavedAddress } from '../domain/types.ts';

export type Interpretation =
  | { kind: 'proposal'; order_id: string; new_address_id: string }
  | { kind: 'clarification'; reason: 'WHICH_ORDER' | 'WHICH_ADDRESS'; candidates: string[] }
  | { kind: 'refusal'; reason: 'ORDER_NOT_FOUND' | 'ORDER_NOT_ELIGIBLE' | 'NO_ELIGIBLE_ORDER' | 'ADDRESS_NOT_FOUND' | 'ADDRESS_UNCHANGED' };

/** Words that refer to each saved-address label. Labels come from the "Label: …" prefix. */
const LABEL_WORDS: Record<string, string[]> = {
  home: ['home', 'house', 'my place'],
  office: ['office', 'work', 'workplace'],
  parents: ['parents', "parents'", 'mum', 'mom', 'dad', 'family'],
};

const labelOf = (a: SavedAddress) => a.normalized_address.split(':')[0]?.trim().toLowerCase() ?? '';
const unique = <T>(xs: T[]) => [...new Set(xs)];

function mentionsLabel(text: string, label: string): boolean {
  return (LABEL_WORDS[label] ?? [label]).some((w) => new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(text));
}

export function interpret(message: string, orders: Order[], addresses: SavedAddress[]): Interpretation {
  const text = message.toLowerCase();

  // 1. Which order?
  const mentionedOrders = unique(text.match(/\bord_[a-z0-9]{1,32}\b/g) ?? []);
  let order: Order | undefined;
  if (mentionedOrders.length > 1) return { kind: 'clarification', reason: 'WHICH_ORDER', candidates: mentionedOrders };
  if (mentionedOrders.length === 1) {
    order = orders.find((o) => o.id === mentionedOrders[0]);
    if (!order) return { kind: 'refusal', reason: 'ORDER_NOT_FOUND' };
    if (!isEligibleForAddressChange(order.status)) return { kind: 'refusal', reason: 'ORDER_NOT_ELIGIBLE' };
  } else {
    const eligible = orders.filter((o) => isEligibleForAddressChange(o.status));
    if (eligible.length === 0) return { kind: 'refusal', reason: 'NO_ELIGIBLE_ORDER' };
    if (eligible.length > 1) return { kind: 'clarification', reason: 'WHICH_ORDER', candidates: eligible.map((o) => o.id) };
    order = eligible[0] as Order;
  }

  // 2. Which saved address?
  const mentionedIds = unique(text.match(/\baddr_[a-z0-9]{1,32}\b/g) ?? []);
  let candidates: SavedAddress[];
  if (mentionedIds.length > 0) {
    candidates = addresses.filter((a) => mentionedIds.includes(a.id));
    if (candidates.length < mentionedIds.length) return { kind: 'refusal', reason: 'ADDRESS_NOT_FOUND' };
  } else {
    candidates = addresses.filter((a) => mentionsLabel(text, labelOf(a)));
  }
  if (candidates.length === 1 && candidates[0]?.id === order.address_id) return { kind: 'refusal', reason: 'ADDRESS_UNCHANGED' };
  const targets = candidates.filter((a) => a.id !== order.address_id);
  if (targets.length !== 1) {
    const pool = targets.length > 1 ? targets : addresses.filter((a) => a.id !== order.address_id);
    return { kind: 'clarification', reason: 'WHICH_ADDRESS', candidates: pool.map((a) => a.id) };
  }
  return { kind: 'proposal', order_id: order.id, new_address_id: (targets[0] as SavedAddress).id };
}
