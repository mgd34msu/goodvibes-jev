// Ported from goodvibes-tui src/test/input/permissions-rules-command.test.ts.
// The TUI keeps the `/permissions` registration; the command logic it calls
// is runPermissionsCommand in gate/policy/permissions-runtime.ts.
import { describe, expect, test } from 'bun:test';
import type { StoredUserPermissionRule } from '../sdk/src/platform/permissions/user-rule-store.ts';
import {
  runPermissionsCommand,
  type PermissionRuleSelectionItem,
  type PermissionRuleSelectionResult,
  type PermissionsCommandContext,
  type RememberedRuleStore,
} from '../sdk/src/platform/gate/policy/permissions-runtime.ts';

function makeRuleStore(initial: Array<{ id: string; tool: string; effect: 'allow' | 'deny'; tier: 'tool' | 'command'; description?: string }>) {
  const records = initial.map((r) => ({
    rule: { type: 'prefix', id: r.id, description: r.description, effect: r.effect, origin: 'user', toolPattern: r.tool, commandPrefixes: [] },
    tier: r.tier,
    tool: r.tool,
    createdAt: 0,
  })) as unknown as StoredUserPermissionRule[];
  const deleted: string[] = [];
  const store: RememberedRuleStore = {
    list: () => records.slice(),
    delete: async (ruleId: string) => {
      deleted.push(ruleId);
      const idx = records.findIndex((r) => r.rule.id === ruleId);
      if (idx >= 0) { records.splice(idx, 1); return true; }
      return false;
    },
  };
  return { store, deleted };
}

function makeCtx(store: RememberedRuleStore) {
  const printed: string[] = [];
  const selections: Array<{ items: PermissionRuleSelectionItem[]; run: (r: PermissionRuleSelectionResult | null) => void }> = [];
  const ctx: PermissionsCommandContext = {
    ruleStore: store,
    configManager: {
      get: () => undefined,
      describeConfigKeySource: () => { throw new Error('not used'); },
      getConfigPath: () => '/nowhere/settings.json',
      getProjectConfigPath: () => undefined,
    } as unknown as PermissionsCommandContext['configManager'],
    print: (text: string) => { printed.push(text); },
    openSelection: (_title, items, _opts, run) => {
      selections.push({ items, run });
    },
  };
  return { ctx, printed, selections };
}

describe('/permissions rules: list and revoke remembered approvals', () => {
  test('lists remembered rules and revokes the selected one through the live store', async () => {
    const { store, deleted } = makeRuleStore([
      { id: 'rule-1', tool: 'exec', effect: 'allow', tier: 'command', description: 'allow git status' },
      { id: 'rule-2', tool: 'write', effect: 'allow', tier: 'tool' },
    ]);
    const { ctx, selections } = makeCtx(store);

    await runPermissionsCommand(['rules'], ctx);

    expect(selections).toHaveLength(1);
    const call = selections[0]!;
    expect(call.items.map((i) => i.id)).toEqual(['rule-1', 'rule-2']);
    expect(call.items[0]!.label).toBe('exec: allow git status');
    expect(call.items[0]!.actions).toContain('revoke');

    // Pressing the revoke action deletes exactly that rule from the live store.
    call.run({ item: call.items[0]!, action: 'delete' });
    await Promise.resolve();
    expect(deleted).toEqual(['rule-1']);

    // A plain select (Enter) does not revoke.
    call.run({ item: call.items[1]!, action: 'select' });
    await Promise.resolve();
    expect(deleted).toEqual(['rule-1']);
  });

  test('/permissions revoke <id> removes a rule by id', async () => {
    const { store, deleted } = makeRuleStore([{ id: 'rule-x', tool: 'exec', effect: 'allow', tier: 'command' }]);
    const { ctx, printed } = makeCtx(store);

    await runPermissionsCommand(['revoke', 'rule-x'], ctx);
    expect(deleted).toEqual(['rule-x']);
    expect(printed.join('\n')).toContain('Revoked remembered rule: rule-x');
  });

  test('empty state is honest when there are no remembered rules', async () => {
    const { store } = makeRuleStore([]);
    const { ctx, printed, selections } = makeCtx(store);

    await runPermissionsCommand(['rules'], ctx);
    expect(selections).toHaveLength(0);
    expect(printed.join('\n')).toContain('No remembered permission rules');
  });
});
