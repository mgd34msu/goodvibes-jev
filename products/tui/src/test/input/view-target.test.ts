import { describe, expect, test } from 'bun:test';
import type { ProcessKind } from '@goodvibes-jev/engine/sdk/platform/runtime/fleet';
import { parseViewTarget, takeTargetFlag } from '../../input/views.ts';

describe('view target grammar', () => {
  test('recognizes a supported final kind without truncating a namespaced process ID', () => {
    expect(parseViewTarget('contract:contract-1:contract')).toEqual({ id: 'contract:contract-1', kind: 'contract' });
    expect(parseViewTarget('unit:tenant:contract-1:u1:contract-unit')).toEqual({ id: 'unit:tenant:contract-1:u1', kind: 'contract-unit' });
  });

  test('ordinary IDs, agent links and tool links keep their meaning', () => {
    expect(parseViewTarget('5d3f9b21-6d1f-4e5d-9d57-9a60b1a44507')).toEqual({ id: '5d3f9b21-6d1f-4e5d-9d57-9a60b1a44507' });
    expect(parseViewTarget('agent-1:agent')).toEqual({ id: 'agent-1', kind: 'agent' });
    expect(parseViewTarget('read_file:tool')).toEqual({ id: 'read_file', kind: 'tool' });
  });

  test('supports every current public process kind plus the Tools deep-link kind', () => {
    const kinds = ['agent', 'contract', 'contract-group', 'contract-unit', 'workflow', 'trigger', 'schedule', 'watcher', 'background-process', 'acp-agent', 'observed-external', 'code-index', 'tool'] satisfies readonly (ProcessKind | 'tool')[];
    for (const kind of kinds) expect(parseViewTarget(`process-1:${kind}`)).toEqual({ id: 'process-1', kind });
  });

  test('a raw namespaced ID or unknown suffix stays whole and untyped', () => {
    for (const id of ['contract:contract-1', 'unit:contract-1:u1', 'tenant:process-1:future-kind', 'tenant:process-1:toString', 'agent-1:wrfc-chain']) {
      expect(parseViewTarget(id)).toEqual({ id });
    }
  });

  test('missing targets and empty namespace segments cannot select a process', () => {
    for (const raw of [undefined, '', ' ', ':', ':agent', 'agent-1:', 'contract::contract-1:contract', 'contract: :contract', 'unit:contract-1::u1:contract-unit', 'tenant::future-kind']) {
      expect(parseViewTarget(raw)).toBeUndefined();
    }
  });

  test('takeTargetFlag removes only its flag and value and preserves remaining arguments', () => {
    const args = ['open', '--target', 'contract:contract-1:contract', 'rest'];
    expect(takeTargetFlag(args)).toEqual({ id: 'contract:contract-1', kind: 'contract' });
    expect(args).toEqual(['open', 'rest']);
    const missing = ['open', '--target'];
    expect(takeTargetFlag(missing)).toBeUndefined();
    expect(missing).toEqual(['open']);
    const absent = ['open', 'fleet'];
    expect(takeTargetFlag(absent)).toBeUndefined();
    expect(absent).toEqual(['open', 'fleet']);
  });
});
