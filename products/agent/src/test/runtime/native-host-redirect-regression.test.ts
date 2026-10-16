import { expect, test } from 'bun:test';
import { createNativeConversationIntakeBinding } from '../../runtime/native-conversation-intake-host.ts';
import { createNativeWorkSubmissionBinding } from '../../runtime/native-work-submission-host.ts';
import { discoverNativeLedgerProject } from '../../runtime/native-work-ledger-host.ts';

for (const status of [302, 307, 308]) test(`agent native host requests do not follow ${status} redirects`, async () => {
  let leaked = 0;
  const destination = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { leaked++; return Response.json({}); } });
  const origin = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch() { return new Response(null, { status, headers: { location: `http://127.0.0.1:${destination.port}/other` } }); } });
  const host = { baseUrl: `http://127.0.0.1:${origin.port}`, token: 'synthetic-token', workspace: '/tmp' };
  const intake = createNativeConversationIntakeBinding(host, 'project');
  const submission = createNativeWorkSubmissionBinding(host, 'project');
  try {
    await expect(intake.readPrincipal(new AbortController().signal)).rejects.toThrow();
    await expect(intake.client.capture({ requestId: 'request', inputId: 'input', text: 'synthetic original prompt', unsupportedSources: [] })).rejects.toThrow();
    await expect(submission.readPrincipal(new AbortController().signal)).rejects.toThrow();
    await expect(discoverNativeLedgerProject(host, new AbortController().signal)).rejects.toThrow();
    expect(leaked).toBe(0);
  } finally { intake.dispose(); submission.dispose(); origin.stop(true); destination.stop(true); }
});
