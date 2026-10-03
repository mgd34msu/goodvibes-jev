import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerControlRoomRuntimeCommands } from '../../input/commands/control-room-runtime.ts';
import { createRuntimeStore, createDomainDispatch } from '../../runtime/store/index.ts';
import { createContractsReadModel } from '../helpers/ui-read-models.ts';

// Current successor to operator-surfaces-gate's legacy graph-summary fixture.
// This command only reads its supplied store; composing a daemon is unnecessary.
function fixture() {
  const store = createRuntimeStore();
  const dispatch = createDomainDispatch(store);
  const model = createContractsReadModel(store);
  const printed: string[] = [];
  const registry = new CommandRegistry();
  registerControlRoomRuntimeCommands(registry);
  const context = { platform: { readModels: { contracts: model } }, print: (text: string) => printed.push(text) } as unknown as CommandContext;
  return { store, dispatch, model, printed, run: (args: string[]) => registry.execute('orchestration', args, context) };
}

describe('orchestration reads the current contract store', () => {
  test('show renders the selected contract and recorded unit state', async () => {
    const f = fixture();
    f.dispatch.dispatchContractEvent({ type: 'CONTRACT_CREATED', contractId: 'contract-1', sessionId: 'test-session', origin: 'turn', ask: 'Contract One', ownerAgentId: 'owner-1' });
    f.dispatch.dispatchContractEvent({ type: 'CONTRACT_PLANNED', contractId: 'contract-1', goal: 'Repair the fixture', criteria: [], repair: 0,
      groups: [{ id: 'g1', title: 'Repair', kind: 'work', dependsOn: [], unitIds: ['u1'] }],
      units: [{ id: 'u1', groupId: 'g1', title: 'Engineer', role: 'implement', dependsOn: [], attempts: 1 }],
    });
    f.dispatch.dispatchContractEvent({ type: 'CONTRACT_UNIT_STATUS_CHANGED', contractId: 'contract-1', groupId: 'g1', unitId: 'u1', from: 'pending', to: 'running', agentId: 'worker-1' });
    await f.run(['show', 'contract-1']);
    expect(f.printed.join('\n')).toContain('Contract contract-1');
    expect(f.printed.join('\n')).toContain('Contract One');
    expect(f.printed.join('\n')).toContain('u1 implement running Engineer');
    expect(f.printed.join('\n')).toContain('groups: 1');
    expect(f.printed.join('\n')).toContain('units: 1');
    expect(f.printed.join('\n')).toContain('/workstream status contract-1');
  });

  test('missing and unknown contracts stay explicit', async () => {
    const f = fixture();
    await f.run(['show']);
    await f.run(['show', 'missing']);
    expect(f.printed).toEqual(['No contracts recorded yet.', 'Unknown contract: missing']);
  });

  test('read model follows the real store and retains failure and guard evidence', () => {
    const f = fixture();
    let notices = 0;
    const unsubscribe = f.model.subscribe(() => { notices++; });
    f.dispatch.dispatchContractEvent({ type: 'CONTRACT_FAILED', contractId: 'failed', reason: 'Synthetic failure', failureKind: 'other', membersSettled: true });
    f.dispatch.dispatchContractEvent({ type: 'CONTRACT_SPAWN_GUARD_TRIGGERED', agentId: 'worker', depth: 2, activeAgents: 9, reason: 'breadth limit' });
    const snapshot = f.model.getSnapshot();
    expect(notices).toBe(2);
    expect(snapshot.totalContracts).toBe(1);
    expect(snapshot.totalFailed).toBe(1);
    expect(snapshot.activeContractIds).toEqual([]);
    expect(snapshot.spawnGuardTrips).toBe(1);
    expect(snapshot.contracts[0]?.reason).toBe('Synthetic failure');
    unsubscribe();
    f.dispatch.dispatchContractEvent({ type: 'CONTRACT_CANCELLED', contractId: 'cancelled', reason: 'Owner stopped it', filesModified: 0 });
    expect(notices).toBe(2);
  });
});
