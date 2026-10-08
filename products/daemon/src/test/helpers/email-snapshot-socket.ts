/** Product-local synthetic IMAP socket. No network connection or engine-private imports. */
import { EventEmitter } from 'node:events';

export class SnapshotSocket extends EventEmitter {
  readonly commands: string[] = [];
  destroyed = false;
  closed = false;
  readonly reached = Promise.withResolvers<void>();
  constructor(readonly options: {
    validity?: number | null;
    uids?: number[];
    hold?: string;
    gate?: Promise<void>;
    closeGate?: Promise<void>;
    incompleteBody?: boolean;
  } = {}) { super(); }
  greet(): void { if (this.options.hold !== 'greeting') this.feed('* OK synthetic\r\n'); else this.reached.resolve(); }
  feed(value: string): void { if (!this.destroyed) this.emit('data', Buffer.from(value)); }
  write(command: string, _encoding: string, done: (error?: Error) => void): boolean {
    this.commands.push(command); done(); void this.answer(command); return true;
  }
  async answer(command: string): Promise<void> {
    if (this.options.hold && command.includes(this.options.hold)) {
      this.reached.resolve(); await this.options.gate;
      if (!this.options.gate) return;
    }
    if (this.destroyed) return;
    const tag = command.split(' ')[0];
    const done = `${tag} OK complete\r\n`;
    const uid = Number(/UID FETCH (\d+)/.exec(command)?.[1]);
    if (command.includes(' EXAMINE ')) {
      this.feed(`* 2 EXISTS\r\n${this.options.validity === null ? '' : `* OK [UIDVALIDITY ${this.options.validity ?? 7}]\r\n`}${done}`);
    } else if (command.includes(' SEARCH ')) {
      const ids = this.options.uids ?? [42, 43];
      this.feed(`* SEARCH${ids.length ? ` ${ids.join(' ')}` : ''}\r\n${done}`);
    } else if (command.includes('HEADER.FIELDS')) {
      const selected = /UID FETCH ([\d,]+)/.exec(command)?.[1]?.split(',').map(Number) ?? [];
      for (const item of selected) this.section(item, 'HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID TO DELIVERED-TO X-ORIGINAL-TO AUTHENTICATION-RESULTS)', this.headers(item));
      this.feed(done);
    } else if (command.includes('BODY.PEEK[HEADER]')) {
      this.section(uid, 'HEADER', this.headers(uid)); this.feed(done);
    } else if (command.includes('BODYSTRUCTURE')) {
      this.feed(`* 1 FETCH (UID ${uid} BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "8BIT" 14 1))\r\n${done}`);
    } else if (command.includes('BODY.PEEK[')) {
      const section = /BODY.PEEK\[([^\]]+)\]/.exec(command)?.[1] ?? '1';
      if (!this.options.incompleteBody) this.section(uid, section, 'Synthetic body');
      this.feed(done);
    } else this.feed(done);
  }
  headers(uid: number): string { return `From: sender@example.invalid\r\nSubject: Subject ${uid}\r\nContent-Type: text/plain; charset=utf-8\r\nDate: Thu, 08 Oct 2026 00:00:00 +0000\r\n\r\n`; }
  section(uid: number, section: string, value: string): void {
    this.feed(`* 1 FETCH (UID ${uid} BODY[${section}] {${Buffer.byteLength(value)}}\r\n${value})\r\n`);
  }
  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      if (this.options.closeGate) void this.options.closeGate.then(() => this.finishClose());
      else this.finishClose();
    }
    return this;
  }
  private finishClose(): void { this.closed = true; this.emit('close'); }
}
