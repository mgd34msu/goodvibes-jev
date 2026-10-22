import { captureStrictJudgmentJson } from '../../gate/judgment-result.js';
import { verificationHash } from './source.js';
import type { VerificationSource } from './types.js';

/** Restore observations only for workers actually returned by this branch.
 * Retained bytes never restore execution permission or completion approval. */
export function retainedDelegationSources(full: Record<string, unknown>, retained: ReadonlyMap<string, VerificationSource>): VerificationSource[] {
  const known = new Map<string, string>();
  const calls = new Map<string, string>();
  const visit = (messages: unknown, reference: string) => {
    if (!Array.isArray(messages)) return;
    for (const [index, message] of messages.entries()) {
      if (!message || typeof message !== 'object') continue;
      if (message.role === 'assistant' && Array.isArray(message.toolCalls)) for (const call of message.toolCalls) {
        if (call?.name === 'agent' && typeof call.id === 'string'
          && (call.arguments?.mode === 'spawn' || call.arguments?.mode === 'batch-spawn'))
          calls.set(call.id, `${reference}[${index}]; original native agent call`);
      }
      if (message.role !== 'tool' || !calls.has(message.callId) || message.outcome === 'error' || message.outcome === 'cancelled'
        || typeof message.content !== 'string') continue;
      let result: { agentId?: unknown; agents?: unknown };
      try { result = JSON.parse(message.content); } catch { continue; }
      if (!result || typeof result !== 'object') continue;
      const ids = [result.agentId, ...(Array.isArray(result.agents) ? result.agents.map(agent => agent?.id) : [])];
      for (const id of ids) if (typeof id === 'string') known.set(id, calls.get(message.callId)!);
    }
  };
  const archives = full.archive;
  if (Array.isArray(archives)) archives.forEach((entry, index) => visit(entry?.messages, `original archived history ${index}`));
  visit((full.initial as { transcript?: unknown } | null)?.transcript, 'initial.transcript');
  visit(full.transcript, 'transcript');
  const live = new Set(Array.isArray(full.delegated) ? full.delegated.map(agent => agent?.id) : []);
  const sources: VerificationSource[] = [];
  for (const [id, parent] of known) {
    if (live.has(id)) continue;
    for (const source of retained.values()) {
      if (source.kind !== 'observation' || !(source.reference.startsWith(`delegated assignment/result ${id};`)
        || source.reference.startsWith(`delegated ${id}.evidence[`))) continue;
      const reference = `${source.reference}; retained historical worker observation associated with ${parent}. Not a new execution, user instruction or current approval.`;
      sources.push({ ...source, reference, id: `s-${verificationHash([source.kind, reference, source.text]).slice(0, 24)}` });
    }
  }
  return captureStrictJudgmentJson(sources) as VerificationSource[];
}
