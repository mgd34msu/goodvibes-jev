/**
 * Delay the IDLE continuation to reproduce a wake arriving before listener registration.
 * Verify repeated stimuli recover it when the completion predicate remains false.
 */

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import {
  InboundMailboxWatcher,
  resolveWatcherSettings,
} from '../sdk/src/platform/email/inbound/index.ts';
import { makeFakeMailbox, openMailboxSocket, type FakeMailboxServer } from './_helpers/fake-imap-mailbox.ts';
import {
  FakeClock,
  RecordingObserver,
  RecordingSink,
  cleanupInboundScratch,
  fixedRandom,
  makeCursorStore,
  nudgeUntil,
  waitFor,
  watcherConnectionPort,
} from './_helpers/inbound-watcher-harness.ts';

const ACCOUNT = 'primary';
const MAILBOX = 'INBOX';

/**
 * Comfortably longer than the round trip a wake that IS heard needs, and
 * comfortably shorter than the wait below. Long enough that the widened window
 * is not itself a race.
 */
const PROBE_MS = 400;
/**
 * The deadline the lost wake has to miss. Above `PROBE_MS` on purpose: a wake
 * that is merely late still lands inside this, so a failure here means the
 * edge was genuinely dropped rather than delayed.
 */
const LOST_WAKE_DEADLINE_MS = 1_000;

interface Harness {
  readonly watcher: InboundMailboxWatcher;
  readonly mailbox: FakeMailboxServer;
  readonly sink: RecordingSink;
}

const live: Harness[] = [];

afterAll(() => { cleanupInboundScratch(); });

afterEach(async () => {
  while (live.length > 0) {
    const entry = live.pop();
    if (entry === undefined) continue;
    await entry.watcher.stop();
    entry.mailbox.close();
  }
});

async function build(): Promise<Harness> {
  const mailbox = await makeFakeMailbox({ initial: [] });
  const { store: cursors } = await makeCursorStore();
  const sink = new RecordingSink();
  const watcher = new InboundMailboxWatcher({
    settings: resolveWatcherSettings({ account: ACCOUNT, mailbox: MAILBOX }),
    // Forced on rather than read from the environment: this file is the proof
    // that the widening works, so it has to run on an ordinary run too.
    connections: watcherConnectionPort({
      connect: () => openMailboxSocket(mailbox.port),
      username: 'watched@example.test',
      password: 'an-app-password',
      mailbox: MAILBOX,
      timeoutMs: 2_000,
    }, PROBE_MS),
    cursors,
    sink,
    clock: new FakeClock(),
    random: fixedRandom(0.5),
    observer: new RecordingObserver(),
  });
  const harness: Harness = { watcher, mailbox, sink };
  live.push(harness);
  return harness;
}

/** Deliver on the strength of the SERVER's command log, the racy pattern. */
async function startAndDeliver(harness: Harness): Promise<void> {
  harness.watcher.start();
  await waitFor(
    () => harness.mailbox.commands.some((line) => /^\S+ IDLE$/.test(line)),
    'the IDLE command reaching the server',
  );
  harness.mailbox.deliver('sent into the window');
}

describe('the lost-wake probe still reproduces the race it sweeps for', () => {
  test('a one-shot wake edge pushed into the widened window is never heard', async () => {
    const harness = await build();
    await startAndDeliver(harness);

    // The assertion is on the REJECTION. Written as a caught promise rather
    // than `expect(...).rejects` so the message is checked too: a `waitFor`
    // that threw for some other reason would satisfy a bare rejection.
    let failure: unknown = null;
    try {
      await waitFor(
        () => harness.sink.delivered.length >= 1,
        'the delivered message',
        LOST_WAKE_DEADLINE_MS,
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('the delivered message');
    // And nothing arrived, the wake was dropped, not merely late.
    expect(harness.sink.delivered).toEqual([]);
  });

  test('nudgeUntil recovers the same lost wake', async () => {
    const harness = await build();
    await startAndDeliver(harness);

    // Same window, same stimulus, same frozen clock. The only difference is
    // that the wake is re-sent once the interval passes with nothing delivered,
    // which is the entire remedy applied to the four tests that carried this.
    await nudgeUntil(
      harness.mailbox,
      () => harness.sink.delivered.length >= 1,
      'the delivered message',
      { intervalMs: PROBE_MS + 100 },
    );

    expect(harness.sink.uids).toEqual([101]);
  });
});
