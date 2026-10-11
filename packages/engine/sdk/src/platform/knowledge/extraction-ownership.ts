import { captureJudgmentPort, type JudgmentPortCapture } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import type { KnowledgeIngestOwnership } from './ingest-context.js';
import { KnowledgeExtractionJudgmentHoldError } from './extraction-policy.js';
import { prepareRepairJudgmentResult } from './semantic/web-gap-repair/admission.js';
/** Explicit per-extraction restrictions; never a global or ambient replacement port. */
export interface KnowledgeExtractionOwner {
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent: () => void;
  readonly retain: (check: () => void) => void;
  readonly port: (site: string) => JudgmentPort;
}
export function createKnowledgeExtractionOwner(ownership: Pick<KnowledgeIngestOwnership, 'signal' | 'assertCurrent'> = {}): KnowledgeExtractionOwner {
  const { signal, assertCurrent: callerCurrent } = ownership;
  const retained: (() => void)[] = [];
  const captures = new Map<string, JudgmentPortCapture>();
  const assertCaller = () => {
    try {
      if (ownership.signal !== signal || ownership.assertCurrent !== callerCurrent) throw new Error('retired');
      signal?.throwIfAborted(); callerCurrent?.();
      for (const check of retained) check();
    } catch { throw new KnowledgeExtractionJudgmentHoldError(); }
  };
  const assertCurrent = () => {
    assertCaller();
    try { for (const captured of captures.values()) captured.assertCurrent(); }
    catch { throw new KnowledgeExtractionJudgmentHoldError(); }
  };
  return Object.freeze({ signal, assertCurrent, retain(check: () => void) { assertCurrent(); check(); retained.push(check); }, port(site: string) {
    assertCurrent(); let captured = captures.get(site);
    if (!captured) {
      captured = captureJudgmentPort(site, { signal, assertCurrent: assertCaller, prepareResultCapture: prepareRepairJudgmentResult });
      captures.set(site, captured);
    }
    return captured.port;
  } });
}
