/** Actual compiled composer -> paired daemon intake -> native hosted runtime. */
import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { BenchmarkStore } from '@goodvibes-jev/engine/sdk/platform/providers';
import { registerInboxSurface } from '@goodvibes-jev/engine/sdk/platform/intake';
import { WorkspaceRegistrationStore, sharedWorkspaceRegisterPath } from '@goodvibes-jev/engine/sdk/platform/workspace';
import { startDaemonFixture } from '@goodvibes-jev/daemon/testing';
import { seedProviderMetadataCacheFixture, seedProviderModelListCacheFixture } from '../helpers/provider-metadata-cache-fixture.ts';
import { isolatedEnv, lastUserText, makeHome, removeHome, resolveBinary, startStubModel, waitFor, WORKSPACE_QUESTION } from './harness.ts';
import { TerminalFrame } from './terminal-frame.ts';
import { beginAgentHostPairing, completeAgentHostPairing } from '../../runtime/connected-host-pairing-store.ts';
import type { NativeIntakeJournalRecord } from '../../runtime/native-conversation-intake-journal.ts';

const FIRST = '  Explain the native remote owner question  ';
const SECOND = 'Continue that native conversation.';
const ANSWER = 'The native hosted owner answer is forty-two.';
const FOLLOWUP = 'The native continuation retained the first answer.';
const HELD = 'Wait in this native owner turn until I stop it.';

for (const loseStartReply of [false, true]) test(`compiled owner conversation preserves native source and continuation${loseStartReply ? ' after a lost dispatch reply' : ''}`, async () => {
  const localModel = startStubModel(() => ({ text: 'UNEXPECTED LOCAL FALLBACK' }));
  let releaseHeld!: () => void;
  const held = new Promise<void>(resolve => { releaseHeld = resolve; });
  const remoteModel = startStubModel(async request => {
    if (lastUserText(request) === HELD) { await held; return { text: 'UNEXPECTED STOPPED REPLY' }; }
    return { text: lastUserText(request) === SECOND ? FOLLOWUP : ANSWER };
  });
  const home = await makeHome(localModel);
  const root = join(home.root, 'native-remote-host');
  mkdirSync(join(home.root, 'tmp'), { recursive: true });
  home.setAgentSetting('hostedSessions.routeConversationTurns', true);
  const daemon = await startDaemonFixture({ root,
    configure(configManager) {
      const homeDirectory = join(root, 'home');
      seedProviderMetadataCacheFixture({ configManager, homeDirectory, workingDirectory: join(root, 'workspace'), surfaceRoot: 'goodvibes' });
      seedProviderModelListCacheFixture(configManager, 'openai');
      const cache = new BenchmarkStore({ dir: join(homeDirectory, '.goodvibes/tui') }).getCachePath();
      mkdirSync(dirname(cache), { recursive: true });
      writeFileSync(cache, JSON.stringify({ version: 1, fetchedAt: Date.now(), ttlMs: 86_400_000, entries: [] }));
    },
    inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
  });
  const fake = fakePort((name, question) => {
    if (name === 'route') return choiceAnswer(question, 'converse', 0.99);
    if (name === 'relation') return choiceAnswer(question, 'supports', 0.99);
    if (name.startsWith('part_')) return noulAnswer(0.01);
    if (name === 'refuse') return noulAnswer(0.99);
    return choiceAnswer(question, 'act', 0.99);
  });
  const recorded = withDecisionLog(fake.port, daemon.services.judgment.decisionLog);
  const read = spyOn(daemon.services.judgment.port, 'ask').mockImplementation(request => recorded.ask(request));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const calls: { method: string; body: unknown }[] = [];
  const originalInvoke = daemon.services.gatewayMethods.invoke.bind(daemon.services.gatewayMethods);
  let lost = false;
  const transport = spyOn(daemon.services.gatewayMethods, 'invoke').mockImplementation(async (method, invocation) => {
    calls.push({ method, body: invocation.body });
    const result = await originalInvoke(method, invocation);
    // The real owner has already durably dispatched. Only its HTTP response is
    // lost; explicit status must recover it without a second start.
    if (loseStartReply && !lost && method === 'workLedger.turn.startAgent') { lost = true; throw new Error('Owned native response-loss fixture'); }
    return result;
  });
  let stage = 'configure';
  try {
    const modelUrl = new URL(remoteModel.baseURL);
    daemon.services.providerRegistry.registerDiscoveredProviders([{ name: 'native-owner-wire', host: '127.0.0.1', port: Number(modelUrl.port), baseURL: remoteModel.baseURL, models: ['stub-model'], serverType: 'vllm' }]);
    daemon.services.configManager.set('provider.model', 'native-owner-wire:stub-model');
    const scopes = new WorkspaceRegistrationStore({ path: sharedWorkspaceRegisterPath(daemon.services.shellPaths), homeDir: daemon.homeDirectory, daemonStateDir: daemon.services.shellPaths.resolveUserPath() });
    await scopes.add(daemon.workingDirectory);
    const migration = await daemon.fetch('/api/control-plane/methods/pairing.tokens.migrate/invoke', { method: 'POST', body: JSON.stringify({ body: { name: 'Owned native Agent E2E' } }) });
    expect(migration.status).toBe(200);
    const minted = (await migration.json() as { token: { token: string; id: string; name: string; createdAt: number } }).token;
    const paired = minted.token;
    if (!loseStartReply) {
      // Private pairing must win over the existing shared daemon credential;
      // this case intentionally has no environment override.
      writeFileSync(join(home.daemonHome, 'operator-tokens.json'), JSON.stringify({ token: daemon.token }), { mode: 0o600 });
      const attemptId = 'owned-native-private-pairing';
      expect((await beginAgentHostPairing(home.home, daemon.baseUrl, { attemptId, name: minted.name, startedAt: Date.now() })).status).toBe('begun');
      expect((await completeAgentHostPairing(home.home, daemon.baseUrl, attemptId, { token: paired, tokenId: minted.id, name: minted.name, createdAt: minted.createdAt })).status).toBe('paired');
    }
    const frame = new TerminalFrame(180, 50), decoder = new TextDecoder(); let output = '';
    stage = 'spawn';
    child = Bun.spawn([resolveBinary(), '--working-dir', home.workspace, '--runtime-url', daemon.baseUrl], {
      cwd: home.workspace, env: isolatedEnv(home, { GOODVIBES_AGENT_RUNTIME_URL: daemon.baseUrl, ...(loseStartReply ? { GOODVIBES_CONNECTED_HOST_TOKEN: paired } : {}) }),
      terminal: { cols: 180, rows: 50, data(terminal, bytes) { const text = decoder.decode(bytes, { stream: true }); output += text; frame.write(text, reply => terminal.write(reply)); } },
    });
    const find = (label: string, predicate: (text: string) => boolean) => waitFor(label, () => predicate(frame.text()) && frame.text(), 15_000, 20).catch(error => { throw new Error(`${String(error)}\n${frame.text()}`); });
    stage = 'workspace-question';
    await find('workspace question', text => text.includes(WORKSPACE_QUESTION)); child.terminal!.write('\r');
    await find('owner composer', text => text.includes('Ask anything, or type / for commands') && !text.includes(WORKSPACE_QUESTION));
    await waitFor('live composer input', () => { if (frame.text().includes('┃  x')) return true; child!.terminal!.write('\x15x'); return false; }, 10_000, 30);
    child.terminal!.write('\x15'); await find('cleared composer', text => !text.includes('┃  x'));
    stage = 'first-source';
    child.terminal!.write(`${FIRST}\r`);
    const journalPath = join(home.home, '.goodvibes/agent/native-work-submission.json.intake');
    const record = () => (JSON.parse(readFileSync(journalPath, 'utf8')) as { records: NativeIntakeJournalRecord[] }).records[0]!;
    if (loseStartReply) {
      await find('unknown native dispatch', text => text.includes('outcome is unknown') || text.includes('unconfirmed'));
      child.terminal!.write('/work intake-status\r');
    }
    await find('hosted original answer', text => text.includes(ANSWER));
    const firstRecord = structuredClone(record());
    expect(firstRecord.delivery).toBe('hosted'); expect(firstRecord.command.text).toBe(FIRST);
    expect(firstRecord.command.continuation).toBeUndefined(); expect(firstRecord.dispatch).toBeUndefined();
    expect(remoteModel.requests.some(request => request.messages.some(message => message.role === 'user' && message.content === FIRST))).toBe(true);
    expect(localModel.requests).toHaveLength(0);
    child.terminal!.write(`${SECOND}\r`);
    await find('hosted continuation answer', text => text.includes(FOLLOWUP));
    const secondRecord = record();
    expect(secondRecord.command.requestId).not.toBe(firstRecord.command.requestId); expect(secondRecord.command.text).toBe(SECOND);
    expect(secondRecord.command.continuation?.sessionId).toBeTruthy();
    const sessionId = secondRecord.command.continuation!.sessionId;
    const sessions = await daemon.invoke<{ sessions: { id: string; originSurface: string }[] }>('sessions.hosted.list', {});
    expect(sessions.sessions.find(session => session.id === sessionId)?.originSurface).toBe('agent');
    expect(remoteModel.requests.some(request => lastUserText(request) === SECOND && request.messages.some(message => message.role === 'user' && message.content === FIRST) && request.messages.some(message => message.role === 'assistant' && String(message.content).includes(ANSWER)))).toBe(true);
    const count = remoteModel.requests.length;
    child.terminal!.write('/work intake-status\r');
    await find('read-only native status', text => text.includes('Native hosted turn: completed.'));
    expect(record().command).toEqual(secondRecord.command); expect(remoteModel.requests).toHaveLength(count);
    expect(calls.filter(call => call.method === 'workLedger.intake.capture')).toHaveLength(2);
    expect(calls.filter(call => call.method === 'workLedger.turn.startAgent')).toHaveLength(2);
    expect(calls.some(call => call.method === 'sessions.hosted.create' || call.method === 'sessions.steer')).toBe(false);
    if (!loseStartReply) {
      stage = 'native-stop';
      child.terminal!.write(`${HELD}\r`);
      await waitFor('owned native model awaiting Stop', () => remoteModel.requests.some(request => lastUserText(request) === HELD), 10_000, 15);
      const stoppedRecord = record();
      child.terminal!.write('\x1b');
      await waitFor('exact native cancellation request', () => calls.some(call => call.method === 'workLedger.turn.cancel'), 10_000, 15);
      releaseHeld();
      const target = { projectId: stoppedRecord.binding.projectId, inputId: stoppedRecord.command.inputId, sourceRevision: stoppedRecord.hostedSource!.sourceRevision };
      const call = calls.find(call => call.method === 'workLedger.turn.cancel')!;
      const params = call.body as Record<string, unknown>;
      expect(params['body'] ?? params).toEqual(target);
      await waitFor('host-confirmed native cancellation', async () => {
        const response = await fetch(`${daemon.baseUrl}/api/work-ledger/turn/status`, { method: 'POST', headers: { Authorization: `Bearer ${paired}`, 'Content-Type': 'application/json' }, body: JSON.stringify(target) });
        if (!response.ok) throw new Error(`Native status failed: ${response.status}`);
        return (await response.json() as { state: string }).state === 'cancelled';
      }, 10_000, 20);
      expect(record().command).toEqual(stoppedRecord.command);
      expect(output).not.toContain('UNEXPECTED STOPPED REPLY');
    }
    expect(output).not.toContain(paired); expect(output).not.toContain(daemon.token); expect(output).not.toContain('UNEXPECTED LOCAL FALLBACK');
    expect(daemon.services.contractRunner.list({ includeTerminal: true })).toHaveLength(0); expect(daemon.services.agentManager.list()).toHaveLength(0);
  } catch (error) { throw new Error(`Native owner PTY failed at ${stage}: ${String(error)}\nMethods: ${calls.map(call => call.method).join(', ')}`); } finally {
    releaseHeld();
    if (child) { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await child.exited; child.terminal?.close(); }
    try { await daemon.stop(); } finally { read.mockRestore(); transport.mockRestore(); localModel.stop(); remoteModel.stop(); removeHome(home); }
  }
}, 90_000);
