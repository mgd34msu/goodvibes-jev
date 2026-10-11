/** Timestamped local output; semantic observations run once per owned generation. */
import { JudgmentAuthorityRetiredError } from '@goodvibes-jev/engine/errors';
import { readProcessOutput, type ProcessOutputReading } from '@goodvibes-jev/engine/terminal-shell';

export interface ProcessLine {
  readonly at: number;
  readonly text: string;
  readonly stream: 'stdout' | 'stderr';
  /** Undefined observations remain neutrally styled. */
  readonly error: boolean | undefined;
}
export interface ProcessRecordView {
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  readonly done: boolean;
  readonly identity?: string;
}
export const MAX_LINES = 5000;
function clean(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}
interface StoredLine { readonly id: string; readonly at: number; readonly text: string; readonly raw: string; readonly stream: ProcessLine['stream']; error: boolean | undefined; }
interface StreamCursor { chunks: number; partial: string }
interface Source {
  readonly record: ProcessRecordView;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  readonly out: readonly string[];
  readonly err: readonly string[];
  readonly done: boolean;
  readonly identity: string | undefined;
}
interface Entry {
  lifetime: AbortController;
  readonly lines: StoredLine[];
  readonly out: StreamCursor;
  readonly err: StreamCursor;
  readonly observed: Set<string>;
  readonly authorities: Set<() => void>;
  source: Source;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout> | undefined;
  start: (() => void) | undefined;
  port: number | undefined;
  portReading: ProcessOutputReading | undefined;
  dropped: number;
  revision: number;
  needsReading: boolean;
}
const equal = (current: readonly string[], saved: readonly string[]) => current.length === saved.length && saved.every((value, index) => current[index] === value);
const capture = (record: ProcessRecordView): Source => ({ record, stdout: record.stdout, stderr: record.stderr, out: [...record.stdout], err: [...record.stderr], done: record.done, identity: record.identity });
const sameSource = (source: Source, record: ProcessRecordView) => record.stdout === source.stdout && record.stderr === source.stderr && record.done === source.done && record.identity === source.identity && equal(record.stdout, source.out) && equal(record.stderr, source.err);
const appended = (source: Source, record: ProcessRecordView) => record.stdout === source.stdout && record.stderr === source.stderr && record.identity === source.identity && record.stdout.length >= source.out.length && record.stderr.length >= source.err.length && source.out.every((value, index) => record.stdout[index] === value) && source.err.every((value, index) => record.stderr[index] === value);

export class ProcessOutputLog {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Set<Promise<void>>();
  private sequence = 0;
  private disposed = false;
  constructor(private readonly onChange: () => void = () => {}, private readonly quietMs = 750) {}

  poll(records: ReadonlyMap<string, ProcessRecordView>, now = Date.now(), assertSource?: (id: string, record: ProcessRecordView, phase: 'generation' | 'retained') => void): boolean {
    if (this.disposed) return false;
    let changed = false;
    for (const [id, entry] of this.entries) if (!records.has(id)) { this.entries.delete(id); this.retire(entry); changed = true; }
    for (const [id, record] of records) {
      let entry = this.entries.get(id);
      if (entry && !appended(entry.source, record)) { this.entries.delete(id); this.retire(entry); entry = undefined; changed = true; }
      if (!entry) {
        entry = { lifetime: new AbortController(), lines: [], out: { chunks: 0, partial: '' }, err: { chunks: 0, partial: '' }, source: capture(record), controller: new AbortController(), timer: undefined, start: undefined, observed: new Set(), authorities: new Set(), port: undefined, portReading: undefined, dropped: 0, revision: 0, needsReading: true };
        this.entries.set(id, entry);
      } else if (sameSource(entry.source, record) && this.currentAuthority(entry) && !entry.needsReading) continue;
      const prior = entry.controller;
      entry.controller = new AbortController();
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.timer = undefined; entry.start = undefined;
      prior.abort();
      const before = entry.dropped;
      const outChanged = this.read(entry, entry.out, record.stdout, 'stdout', record.done, now);
      const errChanged = this.read(entry, entry.err, record.stderr, 'stderr', record.done, now);
      if (entry.dropped !== before) this.clearObservations(entry);
      entry.source = capture(record);
      entry.port = undefined; entry.portReading = undefined; entry.revision++;
      changed = changed || outChanged || errChanged;
      this.schedule(id, entry, records, assertSource);
    }
    return changed;
  }
  lines(id: string): readonly ProcessLine[] {
    const entry = this.entries.get(id);
    if (!entry) return [];
    this.currentAuthority(entry);
    return entry.lines;
  }
  dropped(id: string): number { return this.entries.get(id)?.dropped ?? 0; }
  revision(id: string): number { return this.entries.get(id)?.revision ?? 0; }
  /** Observed listening information is display only, never an execution grant. */
  port(id: string): number | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    try { entry.portReading?.assertCurrent(); } catch { entry.port = undefined; entry.portReading = undefined; entry.needsReading = true; entry.revision++; }
    return entry.port;
  }
  async whenSettled(): Promise<void> {
    for (const entry of this.entries.values()) entry.start?.();
    await Promise.all([...this.pending]);
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const entry of this.entries.values()) this.retire(entry);
    this.entries.clear();
    await Promise.all([...this.pending]);
  }
  private clearObservations(entry: Entry): void {
    const lifetime = entry.lifetime;
    entry.lifetime = new AbortController();
    lifetime.abort();
    entry.authorities.clear(); entry.observed.clear();
    for (const line of entry.lines) line.error = undefined;
    entry.port = undefined; entry.portReading = undefined; entry.needsReading = true; entry.revision++;
  }
  private currentAuthority(entry: Entry): boolean {
    try { for (const assertCurrent of entry.authorities) assertCurrent(); return true; }
    catch { this.clearObservations(entry); return false; }
  }
  private retire(entry: Entry): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = undefined; entry.start = undefined;
    entry.lifetime.abort(); entry.controller.abort();
  }
  private schedule(id: string, entry: Entry, records: ReadonlyMap<string, ProcessRecordView>, assertSource?: (id: string, record: ProcessRecordView, phase: 'generation' | 'retained') => void): void {
    entry.needsReading = false;
    const controller = entry.controller;
    const source = entry.source;
    const assertCurrent = () => {
      if (this.disposed || this.entries.get(id) !== entry || entry.controller !== controller || controller.signal.aborted || records.get(id) !== source.record || !sameSource(source, source.record)) throw new JudgmentAuthorityRetiredError();
      assertSource?.(id, source.record, 'generation');
    };
    const lines = [...entry.lines];
    const evidence = { lines: lines.map(({ id: lineId, text, raw, stream }) => ({ id: lineId, text, raw, stream })), partials: { stdout: entry.out.partial, stderr: entry.err.partial }, done: source.done };
    const lineIds = lines.filter(line => !entry.observed.has(line.id)).map(line => line.id);
    const start = () => {
      if (entry.start !== start) return;
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.timer = undefined; entry.start = undefined;
      const work = (async () => {
        try {
          assertCurrent();
          const reading = await readProcessOutput(evidence, lineIds, { signal: controller.signal, authoritySignal: entry.lifetime.signal, assertCurrent });
          assertCurrent(); reading.assertCurrent(); reading.recordPublication(); assertCurrent();
          const retained = new Set(entry.lines);
          for (const line of lines) if (retained.has(line) && reading.errors.has(line.id)) { line.error = reading.errors.get(line.id); entry.observed.add(line.id); }
          if (reading.errors.size > 0) entry.authorities.add(() => {
            reading.assertAuthorityCurrent();
            if (records.get(id) !== source.record || !appended(source, source.record)) throw new JudgmentAuthorityRetiredError();
            assertSource?.(id, source.record, 'retained');
          });
          entry.port = reading.port; entry.portReading = reading; entry.revision++;
          this.onChange();
        } catch { /* Missing, private, uncertain or retired observations stay neutral. */ }
      })();
      this.pending.add(work);
      void work.then(() => this.pending.delete(work));
    };
    entry.start = start;
    entry.timer = setTimeout(start, this.quietMs);
  }
  private read(entry: Entry, cursor: StreamCursor, chunks: readonly string[], stream: ProcessLine['stream'], done: boolean, now: number): boolean {
    let changed = false;
    if (chunks.length > cursor.chunks) {
      const parts = (cursor.partial + chunks.slice(cursor.chunks).join('')).split(/\r?\n/);
      cursor.chunks = chunks.length; cursor.partial = parts.pop() ?? '';
      for (const part of parts) this.push(entry, part, stream, now);
      changed = parts.length > 0;
    }
    if (done && cursor.partial) { this.push(entry, cursor.partial, stream, now); cursor.partial = ''; changed = true; }
    return changed;
  }
  private push(entry: Entry, raw: string, stream: ProcessLine['stream'], at: number): void {
    const text = clean(raw.includes('\r') ? raw.slice(raw.lastIndexOf('\r') + 1) : raw).trimEnd();
    entry.lines.push({ id: `line-${this.sequence++}`, at, text, raw, stream, error: undefined });
    if (entry.lines.length > MAX_LINES) { const extra = entry.lines.length - MAX_LINES; entry.lines.splice(0, extra); entry.dropped += extra; }
  }
}
