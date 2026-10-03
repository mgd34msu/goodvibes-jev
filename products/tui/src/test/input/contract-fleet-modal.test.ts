import { describe, expect, test } from 'bun:test';
import type { ProcessNode } from '@goodvibes-jev/engine/sdk/platform/runtime/fleet';
import { AgentsModal } from '../../input/agents-modal.ts';
import { SurfaceModalHost } from '../../input/surface-modal-host.ts';
import { buildFleetSnapshot, createStaticFleetReadModel } from '../../views/fleet-read-model.ts';
import { contractFixture } from '../helpers/contract-work-tree-fixtures.ts';

describe('contract fleet tab compatibility', () => {
  test('Enter attaches a contract tree and renders its public view without requesting an owner transcript', () => {
    const contract = contractFixture({ commit: { status: 'failed', note: 'not applied' } });
    const node: ProcessNode = { id: 'contract:contract-1', kind: 'contract', label: 'Contract repair', state: 'done', elapsedMs: 1000, costState: 'unpriced', capabilities: { interruptible: false, killable: false, resumable: false, pausable: false, steerable: false }, raw: contract };
    let transcriptReads = 0;
    const modal = new AgentsModal({ readModel: createStaticFleetReadModel(buildFleetSnapshot([node])), actions: { interrupt: () => false, resume: () => false, kill: () => [], getConversationSnapshot: () => { transcriptReads++; return []; }, resolveSessionLogPath: () => { throw new Error('contract must never load an agent ledger'); }, steer: () => ({ queued: false, reason: 'not an agent' }) }, requestRender: () => {}, tickMs: 0 });
    const host = new SurfaceModalHost();
    host.push(modal);
    modal.reveal({ kind: 'contract', id: node.id });
    host.handleToken({ type: 'key', name: 'enter', logicalName: 'enter', ctrl: false, meta: false, shift: false });
    expect(modal.tabs.tabs[0]?.kind).toBe('contract');
    const text = modal.render(120, 55).lines.map((line) => line.map((cell) => cell.char).join('')).join('\n');
    expect(text).toContain('passed · commit failed: not applied');
    expect(text).toContain('unit u1');
    expect(transcriptReads).toBe(0);
    host.clear();
  });
});
