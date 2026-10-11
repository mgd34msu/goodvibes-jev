/** Pinned254699bf mapping assertions, with explicit autonomous/privacy-floor adaptations. */
import { afterEach, expect, test } from 'bun:test';
import { createProtectedSourceOwner } from '../sdk/src/platform/security/source-screening/owner.ts';
import { createProtectedInboxMapper } from '../sdk/src/platform/intake/protected-preview.ts';
import { parseIntakeFetchResponse } from '../sdk/src/platform/intake/providers/imap-response.ts';
import { digestSender } from '../sdk/src/platform/intake/text-normalization.ts';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
interface RecordedSource { revision: string; parts: string[]; }
function fixture(selections: readonly { text: string; privateText: string }[] = [], settled = true) {
  const calls: { path: string; source?: RecordedSource }[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/v1/chat/completions') {
      const body = await request.json() as { messages: { content: string }[] };
      const source = JSON.parse(body.messages[1]!.content) as RecordedSource; calls.push({ path, source });
      // Literal recorded fixture offsets, not a source classifier or production fallback.
      const spans = source.parts.flatMap((part, index) => selections.filter(row => row.text === part).map(row => {
        const start = part.indexOf(row.privateText); expect(start).toBeGreaterThanOrEqual(0);
        return { part: index, start, end: start + row.privateText.length };
      }));
      return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ revision: source.revision, spans }) } }] });
    }
    calls.push({ path });
    return Response.json({ model: 'jev-1.13.0', answers: { complete: { type: 'noul', noul: settled ? 1 : 0 },
      precise: { type: 'noul', noul: 1 } }, usage: { input_tokens: 10, output_tokens: 2 } });
  } });
  const owner = createProtectedSourceOwner({ authority: { ownerId: 'recorded-original-mapping', revision: '1', retention: 'ephemeral-no-log',
    signal: new AbortController().signal, assertCurrent() {} },
    proposal: { endpoint: `http://127.0.0.1:${server.port}`, model: 'recorded-proposal' },
    judgment: { endpoint: `http://127.0.0.1:${server.port}`, model: 'jev-1.13.0' },
  });
  cleanups.push(async () => { await owner.close(); await server.stop(true); });
  return { mapper: createProtectedInboxMapper(owner), calls };
}
const input = (text: string, subject = '') => ({ senderId: 'U-some-workspace-user', channelId: 'D-synthetic', subject, text });
for (const row of [
  { text: 'reach me at jane.doe@example.com please', privateText: 'jane.doe@example.com', expected: 'reach me at [redacted] please' },
  { text: 'call +1 (555) 123-4567 now', privateText: '+1 (555) 123-4567', expected: 'call [redacted] now' },
  { text: 'host 10.0.0.42 down', privateText: '10.0.0.42', expected: 'host [redacted] down' },
]) test(`original privacy case uses verified local spans: ${row.privateText}`, async () => {
  const f = fixture([row]), result = await f.mapper(input(row.text));
  expect(result?.bodyPreview).toBe(row.expected); expect(result?.fromDigest).toBe(digestSender('U-some-workspace-user'));
  expect(f.calls.map(call => call.path)).toEqual(['/v1/chat/completions', '/v1/systemone']);
});
test('original ordinary-prose no-span case remains unchanged after recorded Jev acceptance', async () => {
  const f = fixture(), result = await f.mapper(input('hello there friend'));
  expect(result?.bodyPreview).toBe('hello there friend'); expect(result?.subjectPreview).toBe('');
  expect(f.calls).toHaveLength(2);
});
test('original subject maximum is 200 after full-source screening; original PII subject stays protected', async () => {
  const f = fixture([{ text: 're: a@b.com', privateText: 'a@b.com' }]);
  expect((await f.mapper(input('', 'x'.repeat(250))))?.subjectPreview).toHaveLength(200);
  expect(f.calls[0]?.source?.parts[0]).toHaveLength(250);
  expect((await f.mapper(input('', 're: a@b.com')))?.subjectPreview).toBe('re: [redacted]');
});
test('original body maximum is 500, single-line, plain text and redacted after screening full original and normalized candidate', async () => {
  const raw = '<p>mail me at\n  x@y.com</p>', normalized = 'mail me at x@y.com';
  const f = fixture([{ text: raw, privateText: 'x@y.com' }, { text: normalized, privateText: 'x@y.com' }]);
  expect((await f.mapper(input('y'.repeat(600))))?.bodyPreview).toHaveLength(500);
  expect(f.calls[0]?.source?.parts[1]).toHaveLength(600);
  expect((await f.mapper(input(raw)))?.bodyPreview).toBe('mail me at [redacted]');
});
// These original credential/card redaction expectations are deliberately not
// claimed as identical: the canonical pre-judgment safety floor withholds the
// whole source before transport. Nothing weakens that floor to recover a count.
for (const text of ['card 4111111111111111 expires', 'token is xoxb-EXAMPLE-faketoken-donotuse here',
  'Authorization: Bearer abcdefgh-EXAMPLE-faketoken', 'api_key = wordstyle-EXAMPLE-fakevalue-token']) {
  test(`original protected literal is withheld before any model transmission: ${text.split(' ')[0]}`, async () => {
    const f = fixture(); expect(await f.mapper(input(text))).toBeNull(); expect(f.calls).toEqual([]);
  });
}
test('a recorded semantic rejection releases no original email preview and cannot fall back to regex redaction', async () => {
  const text = 'reach me at jane.doe@example.com please';
  const f = fixture([{ text, privateText: 'jane.doe@example.com' }], false);
  expect(await f.mapper(input(text))).toBeNull(); expect(f.calls).toHaveLength(2);
});


test('original absent-subject preview is empty after the real protocol boundary normalizes a missing header', async () => {
  const headers = 'From: Synthetic Sender\r\nDate: Thu, 01 Oct 2026 00:00:00 +0000\r\n';
  const body = 'ordinary note';
  const raw = `* 1 FETCH (UID 7 FLAGS () BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {${Buffer.byteLength(headers)}}\r\n${headers} BODY[TEXT] {${Buffer.byteLength(body)}}\r\n${body})\r\n`;
  const envelopes = parseIntakeFetchResponse(raw);
  expect(envelopes).toHaveLength(1);
  expect(envelopes[0]!.subject).toBe('');
  const f = fixture();
  const result = await f.mapper(input(envelopes[0]!.bodyPreview, envelopes[0]!.subject));
  expect(result?.subjectPreview).toBe('');
  expect(result?.bodyPreview).toBe(body);
  expect(f.calls[0]!.source!.parts).toEqual(['', body, '', body]);
});

test('a missing subject at the protected boundary is withheld rather than bypassing screening', async () => {
  const f = fixture();
  // Protocol owners normalize absent headers; malformed callers get no preview.
  const malformed = { senderId: 'synthetic', channelId: 'synthetic', text: 'ordinary note' };
  expect(await f.mapper(malformed as unknown as Parameters<typeof f.mapper>[0])).toBeNull();
  expect(f.calls).toEqual([]);
});
