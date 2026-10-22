import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeContentQuery } from '../sdk/src/platform/tools/find/content.ts';
import { executeFilesQuery } from '../sdk/src/platform/tools/find/files.ts';
import { FindRuntimeService } from '../sdk/src/platform/tools/find/shared.ts';
import { WebSocketMessageAssembler, encodeWebSocketMessage } from '../transport-core/src/websocket-messages.ts';
import { judgmentInputProblem } from '../sdk/src/platform/gate/judgment-input.ts';
import { appendSharedSessionMessage, listSharedSessionMessages } from '../sdk/src/platform/control-plane/session-broker-messages.ts';
import { createSessionBrokerSnapshot } from '../sdk/src/platform/control-plane/session-broker-state.ts';
import { CONTRACT_CONFIG_DEFAULTS } from '../sdk/src/platform/contract/config.ts';
import { detectStall } from '../sdk/src/platform/contract/progress.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
test('content search scans beyond old per-file and total caps; cached pages retain the full count', async () => {
  const root = mkdtempSync(join(tmpdir(), 'find-pages-')); roots.push(root);
  writeFileSync(join(root, 'a.txt'), Array.from({ length: 150 }, (_, i) => `marker ${i}`).join('\n'));
  const runtime = new FindRuntimeService();
  const query = { id: 'all', mode: 'content' as const, pattern: 'marker' };
  const first = await executeContentQuery(query, {}, runtime, root);
  expect(first).toMatchObject({ count: 150, returned: 100, next_offset: 100 });
  const last = await executeContentQuery(query, { offset: 100 }, runtime, root);
  expect(last).toMatchObject({ count: 150, returned: 50, has_more: false });
  expect((last.matches as { line: number }[]).at(-1)?.line).toBe(150);
  const count = await executeContentQuery(query, { format: 'count_only' }, runtime, root);
  expect(count.count).toBe(150);
});
test('file content filtering runs before pagination', async () => {
  const root = mkdtempSync(join(tmpdir(), 'find-files-pages-')); roots.push(root);
  for (let i = 0; i < 125; i++) writeFileSync(join(root, `${String(i).padStart(3, '0')}.txt`), i === 124 ? 'wanted' : 'ordinary');
  const result = await executeFilesQuery({ id: 'late', mode: 'files', patterns: ['*.txt'], has_content: 'wanted' }, {}, root);
  expect(result.count).toBe(1); expect(result.files).toEqual([join(root, '124.txt')]);
});
test('large Unicode WebSocket messages round-trip and partial messages cannot cross connections', () => {
  const payload = { type: 'response', body: '🌻\\"\n'.repeat(300_000) };
  const frames = [...encodeWebSocketMessage(JSON.stringify(payload))];
  expect(frames.length).toBeGreaterThan(1);
  const assembler = new WebSocketMessageAssembler();
  let result: unknown;
  for (const frame of frames) result = assembler.accept(JSON.parse(frame));
  expect(result).toEqual(payload);
  assembler.accept(JSON.parse(frames[0]!)); assembler.reset();
  expect(() => assembler.accept(JSON.parse(frames[1]!))).toThrow('out-of-order');
});
test('large and deep Jev evidence is inspected completely, including credentials at the end', () => {
  let value: unknown = { note: 'ordinary' };
  for (let i = 0; i < 100; i++) value = { child: value };
  expect(judgmentInputProblem({ text: 'a'.repeat(1_100_000), entries: Array(21_000).fill(null), value })).toBeUndefined();
  expect(judgmentInputProblem({ text: 'a'.repeat(1_100_000), tail: { apiKey: 'synthetic-secret' } })).toBe('credential-material');
});
test('session persistence and pages preserve more than 2000 messages', () => {
  const store = { sessions: new Map(), messages: new Map(), inputs: new Map() };
  for (let i = 0; i < 2100; i++) appendSharedSessionMessage(store, { sessionId: 's', role: 'user', body: `message ${i}` }, Infinity);
  expect(createSessionBrokerSnapshot(store, Infinity).messages).toHaveLength(2100);
  expect(listSharedSessionMessages(store, 's', 100, 2000)[0]?.body).toBe('message 0');
});
test('default workflow counters do not exhaust work', () => {
  expect(CONTRACT_CONFIG_DEFAULTS).toMatchObject({ maxUnits: 0, maxFixRounds: 0, planRepairLimit: 0, maxNudgesPerUnit: 0, evidenceNudgeLimit: 0 });
  expect(detectStall({ criteria: [], checks: [], nudges: Array(20).fill({}) }, { checkId: 'check', trigger: 'completion', met: new Set(), failingGates: 0, qualityProblems: 0, claimsFailed: false }, [], CONTRACT_CONFIG_DEFAULTS)).toBeNull();
});
