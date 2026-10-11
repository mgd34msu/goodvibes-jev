import { captureJudgmentPort, type JudgmentPortCapture, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { assertJudgmentInput } from '../gate/judgment-input.js';
import { fieldKind, type FieldKind } from './batteries/field-kind.js';

type Entry = { readonly status: 'pending'; readonly owner: JudgmentPortCapture; readonly controller: AbortController; readonly promise: Promise<FieldKind | undefined> }
  | { readonly status: 'settled'; readonly owner: JudgmentPortCapture; readonly controller: AbortController; readonly kind: FieldKind };
const MAX_FIELDS = 256;

/** Synchronous consumers withhold values while a field-name reading is pending. */
export class FieldKindReader {
  private readonly controller = new AbortController();
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly options: JudgmentReadingOptions = {}) {}

  read(field: string): FieldKind | undefined {
    let owner: JudgmentPortCapture;
    try {
      assertJudgmentInput({ field });
      owner = captureJudgmentPort('engine.redaction.field-kind', { ...this.options,
        signal: this.options.signal ? AbortSignal.any([this.controller.signal, this.options.signal]) : this.controller.signal });
      owner.assertCurrent();
    } catch { return undefined; }
    const cached = this.entries.get(field);
    if (cached?.owner.identity === owner.identity) {
      try { cached.owner.assertCurrent(); }
      catch { this.entries.delete(field); return undefined; }
      return cached.status === 'settled' ? cached.kind : undefined;
    }
    if (cached) { cached.controller.abort(); this.entries.delete(field); }
    if (this.entries.size >= MAX_FIELDS) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) { this.entries.get(oldest.value)?.controller.abort(); this.entries.delete(oldest.value); }
    }
    const controller = new AbortController();
    try { owner = captureJudgmentPort('engine.redaction.field-kind', { ...this.options,
      signal: AbortSignal.any([this.controller.signal, controller.signal, ...(this.options.signal ? [this.options.signal] : [])]) }); }
    catch { return undefined; }
    const completion = Promise.withResolvers<FieldKind | undefined>();
    const pending: Entry = { status: 'pending', owner, controller, promise: completion.promise };
    this.entries.set(field, pending);
    void fieldKind.run(owner.port, { field }, { site: 'engine.redaction.field-kind', signal: owner.signal, beforeAttempt: owner.assertCurrent })
      .then((result) => {
        owner.assertCurrent();
        if (this.entries.get(field) !== pending) { completion.resolve(undefined); return; }
        const reading = result.readings.kind;
        if (reading.outcome === 'act') {
          this.entries.set(field, { status: 'settled', owner, controller, kind: reading.choice });
          completion.resolve(reading.choice);
        } else { this.entries.delete(field); completion.resolve(undefined); }
      })
      .catch(() => { if (this.entries.get(field) === pending) this.entries.delete(field); completion.resolve(undefined); });
    return undefined;
  }

  async readAsync(field: string): Promise<FieldKind | undefined> {
    const settled = this.read(field);
    if (settled !== undefined) return settled;
    const pending = this.entries.get(field);
    if (pending?.status !== 'pending') return undefined;
    const kind = await pending.promise;
    try { pending.owner.assertCurrent(); } catch { return undefined; }
    return this.entries.get(field)?.owner.identity === pending.owner.identity ? kind : undefined;
  }

  dispose(): void {
    this.controller.abort();
    this.entries.clear();
  }
}
