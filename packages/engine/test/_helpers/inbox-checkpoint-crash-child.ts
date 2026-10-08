/** Synthetic crash fixture: deliberately exits before normal store close. */
import { InboxCursorStore } from '../../sdk/src/platform/intake/cursor-store.ts';
import type { ImapUidCheckpointAdvance, InboundChannelItem } from '../../sdk/src/platform/intake/provider-adapter.ts';
const dir = process.argv[2]!;
const mode = process.argv[3]!;
const store = new InboxCursorStore(dir, undefined, { sweepIntervalMs: 0 });
await store.init();
const previous = store.getImapCheckpoint('email')!;
const item: InboundChannelItem = { id: 'email:7:101', provider: 'email', kind: 'dm', fromDigest: '0123456789abcdef',
  subjectPreview: 'Redacted subject', bodyPreview: 'Redacted body', receivedAt: Date.now(), unread: true };
const advance: ImapUidCheckpointAdvance = { kind: 'imap-uid', transition: 'advance', previous,
  next: { ...previous, lastTerminalUid: 101 }, coveredUids: [101], terminal: [{ uid: 101, disposition: 'published', itemId: item.id }] };
let fences = 0;
await store.commitImapPoll('email', [item], advance, () => {
  if (++fences === 2 && mode === 'before-rename') process.exit(23);
});
process.exit(24);
