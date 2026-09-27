/**
 * turn-budget.test.ts
 *
 * The per-agent turn ceiling as a real configurable feature: a config default,
 * a per-spawn override, and a policy bound the override cannot exceed (the cap
 * always wins). The resolved budget names its source so a turn-budget-exhausted
 * outcome can report it. Also proves the terminal chain outcome carries the
 * machine-readable 'max_turns' kind + the applied limit/source on the wire, so a
 * consumer never has to regex the prose.
 */
import { describe, expect, test } from 'bun:test';
import {
  resolveTurnBudget,
  formatTurnLimitError,
  isTurnBudgetExhaustedMessage,
  TURN_BUDGET_EXHAUSTED,
} from '../sdk/src/platform/agents/turn-budget.ts';
import { emitWrfcChainFailed } from '../sdk/src/platform/agents/wrfc-contract-events.ts';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.ts';

describe('resolveTurnBudget', () => {
  test('no override uses the config default, source "default"', () => {
    expect(resolveTurnBudget({ configDefault: 50, policyCap: 200 })).toEqual({ limit: 50, source: 'default' });
  });

  test('a per-spawn override at or below the cap wins, source "spawn-override"', () => {
    expect(resolveTurnBudget({ configDefault: 50, spawnOverride: 120, policyCap: 200 })).toEqual({ limit: 120, source: 'spawn-override' });
    // Lowering below the default is also a spawn override.
    expect(resolveTurnBudget({ configDefault: 50, spawnOverride: 10, policyCap: 200 })).toEqual({ limit: 10, source: 'spawn-override' });
  });

  test('an override above the cap is clamped to the cap, source "policy-bound": the cap wins', () => {
    expect(resolveTurnBudget({ configDefault: 50, spawnOverride: 5_000, policyCap: 200 })).toEqual({ limit: 200, source: 'policy-bound' });
  });

  test('the config default itself is clamped by the policy cap', () => {
    expect(resolveTurnBudget({ configDefault: 500, policyCap: 200 })).toEqual({ limit: 200, source: 'default' });
  });

  test('invalid inputs fall back sensibly rather than producing a zero/NaN ceiling', () => {
    expect(resolveTurnBudget({ configDefault: 50, spawnOverride: 0, policyCap: 200 }).limit).toBe(50);
    expect(resolveTurnBudget({ configDefault: 50, spawnOverride: Number.NaN, policyCap: 200 }).limit).toBe(50);
  });
});

describe('turn-budget helpers', () => {
  test('the prose message is unchanged and recognizable', () => {
    expect(formatTurnLimitError(50)).toBe('Exceeded maximum turn limit (50)');
    expect(isTurnBudgetExhaustedMessage('Exceeded maximum turn limit (50)')).toBe(true);
    expect(isTurnBudgetExhaustedMessage('max_turns reached')).toBe(true);
    expect(isTurnBudgetExhaustedMessage('network transport error')).toBe(false);
    expect(TURN_BUDGET_EXHAUSTED).toBe('max_turns');
  });
});

describe('CONTRACT_FAILED carries the typed turn-budget outcome on the wire', () => {
  test('failureKind max_turns + turnLimit + turnLimitSource ride the event, prose intact', async () => {
    const bus = new RuntimeEventBus();
    const events: Array<{ payload: Record<string, unknown> }> = [];
    bus.onDomain('contracts', (e) => events.push(e as unknown as { payload: Record<string, unknown> }));

    emitWrfcChainFailed(bus, 'session-1', {
      chainId: 'chain-1',
      reason: 'Exceeded maximum turn limit (120)',
      failureKind: 'max_turns',
      membersSettled: true,
      turnLimit: 120,
      turnLimitSource: 'spawn-override',
    });
    // The bus dispatches each subscriber in its own microtask.
    await Promise.resolve();

    expect(events).toHaveLength(1);
    const payload = events[0]!.payload as Record<string, unknown>;
    expect(payload.type).toBe('CONTRACT_FAILED');
    expect(payload.contractId).toBe('chain-1');
    expect(payload.failureKind).toBe('max_turns');
    expect(payload.turnLimit).toBe(120);
    expect(payload.turnLimitSource).toBe('spawn-override');
    // The human string is unchanged so anything that renders it still works.
    expect(payload.reason).toBe('Exceeded maximum turn limit (120)');
  });
});
