import { JudgmentInputError, snapshotJudgmentEvidence } from '../gate/judgment-input.js';
import { findCardNumberShapes } from '../security/card-shapes.js';
import { fitCompletionEvidence } from './response-completion-budget.js';

/** A local projection of observations, never an invocation or a replacement user request. */
export class CompletionEvidenceProjection {
  private readonly namespace = crypto.randomUUID();
  private readonly references = new Map<string, string>();
  private withheld = new Set<string>();

  private reference(value: string, reason: string): string {
    const key = reason + '\n' + value;
    let reference = this.references.get(key);
    if (!reference) {
      reference = `[WITHHELD:${reason}:${this.namespace}:${this.references.size + 1}]`;
      this.references.set(key, reference);
    }
    this.withheld.add(reference);
    return reference;
  }

  private text(value: string): string {
    const findings = findCardNumberShapes(value);
    let result = value;
    for (const finding of findings.toReversed()) {
      const end = finding.startIndex + finding.length;
      result = result.slice(0, finding.startIndex)
        + this.reference(value.slice(finding.startIndex, end), 'card-shaped-number') + result.slice(end);
    }
    return result;
  }

  private jsonText(value: string): string {
    const findings = findCardNumberShapes(value);
    let position = 0, quoted = false, escaped = false, result = '';
    for (const finding of findings) {
      for (let index = position; index < finding.startIndex; index++) {
        const character = value[index];
        if (escaped) escaped = false;
        else if (quoted && character === '\\') escaped = true;
        else if (character === '"') quoted = !quoted;
      }
      const end = finding.startIndex + finding.length;
      // Strings retain exact digits when parsed; project their decoded contents
      // afterward so JSON encoded inside a string is still valid JSON.
      result += value.slice(position, finding.startIndex) + (quoted ? value.slice(finding.startIndex, end)
        : JSON.stringify(this.reference(value.slice(finding.startIndex, end), 'card-shaped-number')));
      position = end;
    }
    return result + value.slice(position);
  }

  private project(value: unknown): unknown {
    const root: Record<string, unknown> = {};
    const pending: { parent: object; key: string; value: unknown; encodeFrom?: Record<string, unknown> }[] = [{ parent: root, key: 'value', value }];
    while (pending.length) {
      const work = pending.pop()!;
      const assign = (entry: unknown) => Object.defineProperty(work.parent, work.key, { value: entry, enumerable: true, configurable: true, writable: true });
      if (work.encodeFrom) { assign(JSON.stringify(work.encodeFrom.value)); continue; }
      const entry = work.value;
      if (typeof entry === 'string') {
        if (/^\s*[\[{]/.test(entry)) {
          let decoded: unknown;
          // Mask before parsing so a 19-digit number cannot lose precision
          // and escape the local card screen during JSON decoding.
          try { decoded = JSON.parse(this.jsonText(entry)); } catch { assign(this.text(entry)); continue; }
          const holder: Record<string, unknown> = {};
          pending.push({ parent: work.parent, key: work.key, value: undefined, encodeFrom: holder });
          pending.push({ parent: holder, key: 'value', value: decoded });
        } else assign(this.text(entry));
      } else if (typeof entry === 'number') {
        const text = String(entry);
        assign(findCardNumberShapes(text, 1).length ? this.reference(text, 'card-shaped-number') : entry);
      } else if (entry && typeof entry === 'object') {
        const copy = Array.isArray(entry) ? [] : Object.create(null);
        assign(copy);
        for (const [key, child] of Object.entries(entry).reverse()) pending.push({ parent: copy, key: this.text(key), value: child });
      } else assign(entry);
    }
    return root.value;
  }

  private observation(value: unknown): unknown {
    // Preserve ordinary observations exactly; only refused observations need
    // projection. Never reformat unrelated JSON or rewrite valid tool evidence.
    try { return snapshotJudgmentEvidence(value); }
    catch (error) {
      if (!(error instanceof JudgmentInputError) || error.problem === 'unsupported-input') throw error;
      if (error.problem === 'card-material') {
        try { return snapshotJudgmentEvidence(this.project(value)); }
        catch { /* The complete observation remains unavailable if it cannot be safely projected. */ }
      }
      // Never send a raw credential or card field. An unavailable observation
      // is explicit missing evidence, rather than proof of successful work.
      return { unavailableObservation: this.reference(JSON.stringify(value), error.problem), reason: error.problem };
    }
  }

  private transcript(messages: readonly Record<string, unknown>[]): unknown[] {
    return messages.map(message => message.role === 'user' ? message : this.observation(message));
  }

  prepare(source: {
    readonly request: string; readonly response: string; readonly transcript: readonly Record<string, unknown>[];
    readonly tools: readonly string[]; readonly delegated: readonly Record<string, unknown>[];
    readonly requirements: unknown; readonly initial: unknown;
  }): unknown {
    this.withheld = new Set();
    const initial = source.initial as { readonly request: string; readonly transcript: readonly Record<string, unknown>[] } | null;
    const state = {
      ...source,
      transcript: this.transcript(source.transcript),
      delegated: source.delegated.map(agent => this.observation(agent)),
      requirements: this.observation(source.requirements),
      initial: initial ? { request: initial.request, transcript: this.transcript(initial.transcript) } : null,
    };
    // The original request, user messages and exact proposed final remain
    // subject to the strict screen. No original action argument is rewritten.
    const admitted = { ...state, evidenceProjection: {
      withheld: [...this.withheld],
      meaning: 'WITHHELD references contain unavailable private or card-shaped observation values. Equal references identify equal original values; different references must not be conflated. These markers cannot establish hidden contents, arithmetic or claims requiring unavailable evidence. Recover with relevant admissible observations; missing evidence never establishes completion.',
    } };
    return fitCompletionEvidence(snapshotJudgmentEvidence(admitted) as typeof admitted);
  }
}
