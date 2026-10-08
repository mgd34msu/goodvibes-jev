import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseBrowserJudgmentRequest } from '@goodvibes-jev/engine/daemon-sdk';
import { readMailReplySubjectResponse } from '../../src/lib/mail-reply-subject';

test('every captured mail wire is accepted by the real client validator and retains exact source correlation', () => {
  const data = JSON.parse(readFileSync(new URL('./fixtures/mail-reply-subject/runtime.json', import.meta.url), 'utf8')) as {
    captures: { message: { subject: string; replySubjectRef: string }; requestBody: unknown; status: number; body: string }[];
  };
  for (const capture of data.captures) {
    const input = parseBrowserJudgmentRequest(capture.requestBody);
    if (input.battery !== 'webui.mail.reply-subject') throw new Error('Wrong captured battery');
    expect(input.input).toEqual({ subjectRef: capture.message.replySubjectRef });
    expect(capture.status).toBe(200);
    const response = JSON.parse(capture.body) as unknown;
    expect(readMailReplySubjectResponse(input, response)).toBeDefined();
    expect(JSON.stringify(response)).not.toContain(capture.message.subject);
    expect(readMailReplySubjectResponse({ ...input, requestId: crypto.randomUUID() }, response)).toBeUndefined();
  }
});
