/** Synthetic page-only extensions; never credentials, servers or real sockets. */
import { SnapshotSocket } from './mail-inbox-snapshot.js';

export class PageSocket extends SnapshotSocket {
  constructor(options: ConstructorParameters<typeof SnapshotSocket>[0] = {}, readonly page: {
    goneUid?: number;
    incompleteUid?: number;
    malformedSearch?: 'ALL' | 'UNSEEN';
    unseenUids?: number[];
    multipart?: boolean;
    body?: string;
  } = {}) { super(options); }

  override headers(uid: number): string {
    return super.headers(uid).replace('Thu, 08 Oct 2026 00:00:00 +0000',
      uid % 2 ? 'Thu, 01 Jan 1970 00:00:00 +0000' : 'Fri, 01 Jan 2100 00:00:00 +0000');
  }

  override async answer(command: string): Promise<void> {
    const tag = command.split(' ')[0];
    const done = `${tag} OK complete\r\n`;
    const uid = Number(/UID FETCH (\d+)/.exec(command)?.[1]);
    if (this.page.malformedSearch && command.includes(` SEARCH ${this.page.malformedSearch}`)) {
      this.feed(`* SEARCH 42 invalid\r\n${done}`); return;
    }
    if (this.page.unseenUids && command.includes(' SEARCH UNSEEN')) {
      this.feed(`* SEARCH${this.page.unseenUids.length ? ` ${this.page.unseenUids.join(' ')}` : ''}\r\n${done}`); return;
    }
    if (this.page.goneUid === uid && command.includes('BODY.PEEK[HEADER]')) { this.feed(done); return; }
    if (this.page.incompleteUid === uid && command.includes('BODY.PEEK[1]')) { this.feed(done); return; }
    if (this.page.multipart && command.includes('BODYSTRUCTURE')) {
      this.feed(`* 1 FETCH (UID ${uid} BODYSTRUCTURE (("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "8BIT" 5 1)("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "8BIT" 11 1)("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "8BIT" 6 1) "ALTERNATIVE"))\r\n${done}`); return;
    }
    if (this.page.multipart && /BODY.PEEK\[[123]\]/.test(command)) {
      const section = /BODY.PEEK\[([123])\]/.exec(command)![1]!;
      this.section(uid, section, section === '1' ? 'First' : section === '2' ? '<b>HTML</b>' : 'Second');
      this.feed(done); return;
    }
    if (this.page.body !== undefined && command.includes('BODYSTRUCTURE')) {
      this.feed(`* 1 FETCH (UID ${uid} BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "8BIT" ${Buffer.byteLength(this.page.body)} 1))\r\n${done}`); return;
    }
    if (this.page.body !== undefined && command.includes('BODY.PEEK[1]')) {
      this.section(uid, '1', this.page.body); this.feed(done); return;
    }
    await super.answer(command);
  }
}
