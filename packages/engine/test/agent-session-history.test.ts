import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSession } from '../sdk/src/platform/agents/session.js';
import { readAgentSessionHistory } from '../sdk/src/platform/agents/session-history.js';
import { AgentManager, createAgentTool } from '../sdk/src/platform/tools/agent/index.js';
import { AgentMessageBus } from '../sdk/src/platform/agents/message-bus.js';
import { resolveScopedDirectory } from '../sdk/src/platform/runtime/surface-root.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function savedWorker() {
  const root = mkdtempSync(join(tmpdir(), 'native-agent-history-')); roots.push(root);
  const sessions = resolveScopedDirectory(root, 'tui', 'sessions', 'agents');
  const session = new AgentSession('agent-saved', 'model', 'provider', { sessionsDir: sessions, stateDir: join(root, 'state') });
  session.conversation.addUserMessage('Read review.md only; do not repeat tests.');
  session.conversation.addAssistantMessage('', { toolCalls: [{ id: 'read-report', name: 'read', arguments: { path: 'review.md' } }] });
  const output = 'Complete observed report line.\n'.repeat(80) + 'Final native counts: 2 passed, 1 failed, exit 1.';
  session.conversation.addToolResults([{ callId: 'read-report', success: true, output }]);
  session.conversation.addAssistantMessage('All three report sections record 2 passed, 1 failed, exit 1.');
  await session.dispose();
  return { root, session, output, request: { projectRoot: root, surfaceRoot: 'tui', agentId: session.agentId, assertCurrent() {} } };
}

test('agent get after restart returns the saved complete conversation without creating a live agent', async () => {
  const { root, session, output } = await savedWorker();
  const manager = new AgentManager(), messageBus = new AgentMessageBus();
  const tool = createAgentTool({ manager, messageBus, configManager: { get() { throw new Error('History lookup must not read unrelated settings'); } },
    contractRunner: { start() { throw new Error('Historical lookup cannot start contracts'); }, list: () => [], get: () => null },
    projectRoot: root, surfaceRoot: 'tui', resolveSessionId: () => 'owner' });
  const result = await tool.execute({ mode: 'get', agentId: session.agentId });
  expect(result.success, result.error).toBe(true);
  const value = JSON.parse(result.output!);
  expect(value.historical).toBe(true);
  expect(value.history.executionActive).toBe(false);
  expect(value.history.messages[2]).toMatchObject({ role: 'tool', callId: 'read-report', content: output });
  expect(value.history.messages[3].content).toContain('2 passed, 1 failed, exit 1');
  expect(manager.list()).toEqual([]);
  expect(manager.getStatus(session.agentId)).toBeNull();
  const summary = await tool.execute({ mode: 'get', agentId: session.agentId, detail: 'summary' });
  expect(JSON.parse(summary.output!).history).toMatchObject({ messageCount: 4, executionActive: false });
  expect(summary.output).not.toContain(output);
  manager.importState([{ id: session.agentId, task: 'Read review.md only; do not repeat tests.', template: 'general', tools: ['read'],
    status: 'completed', startedAt: 0, toolCallCount: 1, orchestrationDepth: 0, executionProtocol: 'direct', reviewMode: 'none', communicationLane: 'parent-only' }]);
  const restored = await tool.execute({ mode: 'get', agentId: session.agentId });
  expect(JSON.parse(restored.output!).history.messages[2].content).toBe(output);
  expect(manager.getStatus(session.agentId)?.fullOutput).toBeUndefined();
});

test.each(['denied', 'cancelled', 'rewritten', 'replaced', 'retired'] as const)('historical lookup holds a %s source', async boundary => {
  const { request, session } = await savedWorker();
  const controller = new AbortController(); let current = true;
  const lookup = readAgentSessionHistory({ ...request, signal: controller.signal, assertCurrent() { if (!current) throw new Error('Retired history caller'); },
    async readAccessFilter() {
      if (boundary === 'denied') return false;
      if (boundary === 'cancelled') controller.abort();
      if (boundary === 'retired') current = false;
      if (boundary === 'rewritten') writeFileSync(session.sessionFile, readFileSync(session.sessionFile, 'utf8').replace('Final native counts', 'Changed native counts'));
      if (boundary === 'replaced') { renameSync(session.sessionFile, session.sessionFile + '.old'); writeFileSync(session.sessionFile, readFileSync(session.sessionFile + '.old')); }
      return true;
    } });
  if (boundary === 'cancelled' || boundary === 'retired') await expect(lookup).rejects.toThrow();
  else expect(await lookup).toBeUndefined();
});

test('journal symlinks, traversal, another surface and abbreviated legacy logs cannot supply full history', async () => {
  const { request, session } = await savedWorker();
  expect(await readAgentSessionHistory({ ...request, agentId: '../agent-saved' })).toBeUndefined();
  expect(await readAgentSessionHistory({ ...request, surfaceRoot: 'daemon' })).toBeUndefined();
  const legacy = JSON.stringify({ type: 'meta', agentId: request.agentId }) + '\n'
    + JSON.stringify({ type: 'tool_execution', resultPreview: 'Only a 500-character preview, not the full result.' }) + '\n';
  writeFileSync(session.sessionFile, legacy);
  expect(await readAgentSessionHistory(request)).toBeUndefined();
  renameSync(session.sessionFile, session.sessionFile + '.actual');
  symlinkSync(session.sessionFile + '.actual', session.sessionFile);
  expect(await readAgentSessionHistory(request)).toBeUndefined();
});

test('a newer unfinished run and malformed latest history cannot revive an earlier saved result', async () => {
  const { request, session } = await savedWorker();
  const original = readFileSync(session.sessionFile, 'utf8');
  writeFileSync(session.sessionFile, original + JSON.stringify({ type: 'meta', agentId: request.agentId }) + '\n');
  expect(await readAgentSessionHistory(request)).toBeUndefined();
  writeFileSync(session.sessionFile, original + '{broken final journal row\n');
  expect(await readAgentSessionHistory(request)).toBeUndefined();
});
