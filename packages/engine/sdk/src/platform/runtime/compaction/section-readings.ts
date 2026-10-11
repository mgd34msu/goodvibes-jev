/** One compaction pass owns these source-bound readings. No memo, provider-text
 * fallback, or diagnostic stores source bodies. Failure leaves the caller's
 * original conversation intact; only qualified membership may remove text. */
import { estimateTokens as judgmentTokens, LIMITS, mapLimit } from '@goodvibes-jev/judgment';
import type { ProviderMessage } from '../../providers/interface.js';
import type { OwnedJudgmentWork } from '../owned-judgment-work.js';
import { conversationSubstance, toolResultRelevance, resolvedProblemEvidence } from './batteries/section-selection.js';

import { checkedCompactionPort, CompactionReadingError } from './section-judgment.js';
export { CompactionReadingError } from './section-judgment.js';
import { readDependencyQualifiedMembership, type CompactionEvidenceCase } from './section-evidence.js';

type SelectionBattery = typeof conversationSubstance;

function sourcePrefix(message: ProviderMessage): string {
  if (message.role === 'tool') return `[tool${message.name ? ` ${message.name}` : ''}; call ${message.callId}]: `;
  const calls = message.role === 'assistant' ? (message.toolCalls ?? []).map(call =>
    `[call ${call.id}; ${call.name}]: ${JSON.stringify(call.arguments)}`).join('\n') : '';
  return `[${message.role}]: ${calls ? `\n${calls}\n` : ''}`;
}
function render(message: ProviderMessage): string {
  const body = typeof message.content === 'string' ? message.content.trim() : message.content.map(part => {
    if (part.type === 'text') return part.text;
    // Text-only canonical readers cannot qualify image meaning.
    throw new CompactionReadingError('unsupported-image');
  }).join('');
  return sourcePrefix(message) + body;
}

/** Every candidate is adjudicated against the same complete, ordered source.
 * Do not replace earlier evidence with a boolean accumulator: later references
 * can depend on earlier identity mappings. Oversized source fails explicitly. */
async function select(battery: SelectionBattery, candidates: readonly ProviderMessage[], conversation: string, source: readonly ProviderMessage[], work: OwnedJudgmentWork): Promise<Set<number>> {
  if (!candidates.length) return new Set();
  const states = candidates.map(message => Object.freeze({ candidateSourcePosition: source.indexOf(message) + 1, conversation }));
  const questionTokens = judgmentTokens(battery.items.selected.question);
  if (states.some(state => judgmentTokens(state) + questionTokens > Math.min(LIMITS.maxStateWithQuestionTokens, LIMITS.maxRequestTokens))) {
    throw new CompactionReadingError('budget');
  }
  const options = work.options(battery.name);
  const port = checkedCompactionPort(options.port!, work);
  const selected = await mapLimit(states, 4, async (state, index) => {
    work.assertCurrent();
    const run = await work.wait(() => battery.run(port, state, {
      site: battery.name, signal: work.signal, beforeAttempt: work.assertCurrent,
    }));
    work.assertCurrent();
    if (run.readings.selected.outcome !== 'act') throw new CompactionReadingError('unqualified');
    const keep = run.readings.selected.verdict === 'yes';
    run.recordAction(keep ? 'retain-source' : 'omit-source');
    return keep ? index : -1;
  });
  return new Set(selected.filter(index => index >= 0));
}

/** Budget fitting quotes exact source prefixes, visibly marks clipping, and
 * retains source order. No generated claims or free-form output are installed. */
export function renderSelected(messages: readonly ProviderMessage[], selected: ReadonlySet<number>, budgetTokens: number): string {
  const kept = messages.filter((_, index) => selected.has(index));
  const lines = kept.map(render);
  const budget = Math.max(0, budgetTokens * 4);
  if (lines.join('\n\n').length <= budget) return lines.join('\n\n');
  // Equal per-message room avoids silently choosing which selected fact matters.
  const marker = ' [clipped]';
  const cap = Math.floor((budget - Math.max(0, lines.length - 1) * 2) / lines.length);
  if (cap <= marker.length || kept.some(message => sourcePrefix(message).length > cap - marker.length)) {
    throw new CompactionReadingError('budget');
  }
  return lines.map(line => line.length <= cap ? line : line.slice(0, cap - marker.length) + marker).join('\n\n');
}

/** Structural source relations, independent of semantic inclusion. */
function sourcePartners(messages: readonly ProviderMessage[]): (index: number) => readonly number[] {
  const links = new Map<number, Set<number>>(); const calls = new Map<string, number>();
  const link = (from: number, to: number) => { const found = links.get(from) ?? new Set<number>(); found.add(to); links.set(from, found); };
  let user = -1;
  messages.forEach((message, index) => {
    if (message.role === 'user') user = index;
    if (message.role === 'assistant') {
      if (user >= 0) link(index, user);
      for (const call of message.toolCalls ?? []) calls.set(call.id, index);
    }
    if (message.role === 'tool') {
      const owner = calls.get(message.callId);
      if (owner !== undefined) { link(index, owner); link(owner, index); }
    }
  });
  return index => {
    const seen = new Set<number>([index]); const pending = [index];
    for (const current of pending) for (const next of links.get(current) ?? []) {
      if (!seen.has(next)) { seen.add(next); pending.push(next); }
    }
    return [...seen];
  };
}

export async function readCompactionSections(input: {
  readonly messages: readonly ProviderMessage[];
  readonly gathered: readonly ProviderMessage[];
  readonly conversationBudget: number;
  readonly toolBudget: number;
  readonly problemsBudget: number;
}, work: OwnedJudgmentWork): Promise<{ conversation: string; tools: string; problems: string }> {
  const sources = input.messages.map(render);
  const conversation = sources.map((source, index) => `#${index + 1} ${source}`).join('\n\n');
  const partners = sourcePartners(input.messages);
  const tools = input.messages.filter(message => message.role === 'tool');
  const exchanges = input.messages.filter(message => message.role === 'user' || message.role === 'assistant');
  try {
    const groups = [
      { battery: conversationSubstance, candidates: input.gathered },
      { battery: toolResultRelevance, candidates: tools },
      { battery: resolvedProblemEvidence, candidates: exchanges },
    ];
    const fullSourceFits = groups.every(({ battery }) => judgmentTokens({ conversation, candidateSourcePosition: input.messages.length })
      + judgmentTokens(battery.items.selected.question) <= Math.min(LIMITS.maxStateWithQuestionTokens, LIMITS.maxRequestTokens));
    let selections: Set<number>[];
    if (fullSourceFits) {
      selections = await Promise.all(groups.map(({ battery, candidates }) => select(battery, candidates, conversation, input.messages, work)));
    } else {
      const cases: CompactionEvidenceCase[] = groups.flatMap(({ battery, candidates }, group) => candidates.map((candidate, index) => ({
        id: `c${group}_${index}`, sourceIndex: input.messages.indexOf(candidate), battery,
      })));
      const membership = await readDependencyQualifiedMembership(sources, cases, partners, work);
      selections = groups.map(({ candidates }, group) => new Set(candidates.flatMap((_, index) => membership.get(`c${group}_${index}`) ? [index] : [])));
    }
    const [recent, relevant, resolved] = selections as [Set<number>, Set<number>, Set<number>];
    work.assertCurrent();
    // Keep complete structural partners even when gathering began mid-exchange.
    const expanded = (candidates: readonly ProviderMessage[], selected: ReadonlySet<number>) => new Set([...selected].flatMap(index =>
      partners(input.messages.indexOf(candidates[index]!))));
    const recentSource = expanded(input.gathered, recent);
    const toolSource = expanded(tools, relevant);
    return {
      conversation: renderSelected(input.messages, recentSource, input.conversationBudget),
      tools: renderSelected(input.messages, toolSource, input.toolBudget),
      problems: renderSelected(exchanges, resolved, input.problemsBudget),
    };
  } catch (error) {
    // Retire sibling requests too; late answers cannot log or install a handoff.
    try { work.assertCurrent(); }
    finally { work.retire(); }
    // Never publish provider exception bodies (they can echo private source).
    throw error instanceof CompactionReadingError ? error : new CompactionReadingError('unavailable');
  }
}
