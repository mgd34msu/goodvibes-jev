/** Exact canonical-read/recorded-judgment replay; synthetic source and answers, never live calibration. */
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { parseBrowserJudgmentRequest, type BrowserJudgmentRequest } from '@goodvibes-jev/engine/daemon-sdk';
import type { OperatorMethodOutput } from '../../src/lib/goodvibes';
import { installMockDaemon } from './mock-daemon';

type Input = BrowserJudgmentRequest<'webui.mail.reply-subject'>;
interface Capture { message: OperatorMethodOutput<'email.inbox.read'>; requestBody: Input; status: number; body: string }
const load = (): Capture[] => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/mail-reply-subject/runtime.json', import.meta.url), 'utf8')) as { captures: Capture[] };
  for (const capture of fixture.captures) {
    const request = parseBrowserJudgmentRequest(capture.requestBody);
    const answer = JSON.parse(capture.body) as { requestId: string; battery: string; evidence: { decisionId: string }[] };
    if (request.battery !== 'webui.mail.reply-subject' || request.input.subjectRef !== capture.message.replySubjectRef || capture.status !== 200
      || answer.requestId !== request.requestId || answer.battery !== request.battery || answer.evidence.length !== 1 || !answer.evidence[0]?.decisionId) throw new Error('Mail runtime capture is not source-bound.');
  }
  return fixture.captures;
};

export async function installMailReplySubjectDaemon(page: Page, options: { subject?: string; holdFirst?: boolean; missingReference?: boolean; fail?: boolean } = {}) {
  const daemon = await installMockDaemon(page, { email: 'configured' });
  const capture = load().find(item => item.message.subject === (options.subject ?? 'Nightly build finished'));
  if (!capture) throw new Error('Missing synthetic subject capture.');
  const judgments: Input[] = [];
  const pending: (() => Promise<void>)[] = [];
  await page.route('**/api/email/inbox/1002', route => {
    const message = { ...capture.message };
    if (options.missingReference) delete message.replySubjectRef;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(message) });
  });
  await page.route('**/api/judgment/batteries/run', async route => {
    if (route.request().headers()['authorization'] !== 'Bearer e2e-operator-token') throw new Error('Mail judgment lost operator authentication.');
    const request = parseBrowserJudgmentRequest(route.request().postDataJSON());
    if (request.battery !== 'webui.mail.reply-subject' || request.input.subjectRef !== capture.message.replySubjectRef) throw new Error('Mail judgment changed its source binding.');
    judgments.push(request);
    const capturedCorrelation = `"requestId":${JSON.stringify(capture.requestBody.requestId)}`;
    if (capture.body.split(capturedCorrelation).length !== 2) throw new Error('Ambiguous captured correlation.');
    const fulfill = async () => {
      await route.fulfill(options.fail
        ? { status: 503, contentType: 'application/json', body: JSON.stringify({ status: 'held', error: { code: 'JUDGMENT_UNAVAILABLE' } }) }
        : { status: capture.status, contentType: 'application/json', body: capture.body.replace(capturedCorrelation, `"requestId":${JSON.stringify(request.requestId)}`) });
    };
    if (options.holdFirst && judgments.length === 1) pending.push(async () => { try { await fulfill(); } catch { /* A cancelled browser request may no longer accept its late answer. */ } });
    else await fulfill();
  });
  return { ...daemon, judgments, capture, get pendingCount() { return pending.length; },
    async release() { await Promise.all(pending.splice(0).map(finish => finish())); } };
}
