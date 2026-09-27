/**
 * `/permissions`, the permission settings surface, as engine logic.
 *
 * Hoisted from the TUI (src/input/commands/permissions-runtime.ts). The
 * product keeps its command registration and hands this module a narrow
 * context: a print sink, the remembered-rule store, the config manager and,
 * when the surface has one, a selection picker. Every printed line is
 * unchanged.
 *
 * With no arguments it prints every permission-relevant setting in effect and
 * where each value came from (provenance; read-only). `rules` lists the
 * durable remembered approvals with a press-Enter revoke; `revoke <id>`
 * removes one by id. Revokes hit the same in-process rule store the evaluator
 * reads, so they take effect live.
 */
import type { StoredUserPermissionRule, UserPermissionRuleStore } from '../../permissions/user-rule-store.js';
import { summarizeError } from '../../utils/error-display.js';
import { buildPermissionProvenance, renderPermissionProvenance, type ConfigProvenanceManager } from './permissions-provenance.js';

/** One row the rule picker shows. */
export interface PermissionRuleSelectionItem {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly actions: string;
}

/** What the picker hands back: the row and the action pressed on it. */
export interface PermissionRuleSelectionResult {
  readonly item: { readonly id: string; readonly label: string };
  readonly action: string;
}

/** The remembered-rule store operations the command uses. */
export type RememberedRuleStore = Pick<UserPermissionRuleStore, 'list' | 'delete'>;

export interface PermissionsCommandContext {
  print(text: string): void;
  /** Absent on a surface without remembered rules. */
  readonly ruleStore?: RememberedRuleStore | undefined;
  readonly configManager: ConfigProvenanceManager;
  /** The surface's selection picker, when it has one. */
  readonly openSelection?: ((
    title: string,
    items: PermissionRuleSelectionItem[],
    options: { readonly allowSearch: boolean; readonly customActions: Map<string, 'delete'> },
    onResult: (result: PermissionRuleSelectionResult | null) => void,
  ) => void) | undefined;
}

/** The command's registration fields; the product adds the handler. */
export const PERMISSIONS_COMMAND = {
  name: 'permissions',
  aliases: ['perms'],
  description: 'Show permission settings and provenance, and list or revoke remembered approval rules',
  usage: '[rules | revoke <rule-id>]',
  argsHint: '[rules|revoke]',
} as const;

/** One remembered-rule row: what it does, and how/when it was remembered. */
function describeRuleRow(record: Pick<StoredUserPermissionRule, 'rule' | 'tier' | 'tool' | 'createdAt'>): { label: string; detail: string } {
  const what = record.rule.description ?? record.rule.id;
  return {
    label: `${record.tool}: ${what}`,
    detail: `${record.rule.effect} · remembered ${record.tier} · ${new Date(record.createdAt).toLocaleString()}`,
  };
}

function showRememberedRules(ctx: PermissionsCommandContext): void {
  const store = ctx.ruleStore;
  if (!store) {
    ctx.print('Remembered permission rules are not available on this surface.');
    return;
  }
  const records = store.list();
  if (records.length === 0) {
    ctx.print('No remembered permission rules. Approving an ask with a remember tier stores one here.');
    return;
  }
  if (ctx.openSelection) {
    const revoke = new Map<string, 'delete'>([['d', 'delete']]);
    const items: PermissionRuleSelectionItem[] = records.map((record) => {
      const { label, detail } = describeRuleRow(record);
      return { id: record.rule.id, label, detail, actions: '[d] revoke' };
    });
    ctx.openSelection('Remembered permission rules', items, { allowSearch: true, customActions: revoke }, (result) => {
      if (!result || result.action !== 'delete') return;
      void (async () => {
        try {
          const removed = await store.delete(result.item.id);
          ctx.print(removed ? `Revoked remembered rule: ${result.item.label}` : `Rule already gone: ${result.item.label}`);
        } catch (error) {
          ctx.print(`Could not revoke the rule: ${summarizeError(error)}`);
        }
      })();
    });
    return;
  }
  // No selection surface: list them honestly with the revoke command to run.
  ctx.print([
    'Remembered permission rules:',
    ...records.map((record) => {
      const { label, detail } = describeRuleRow(record);
      return `  ${record.rule.id}  ${label}  (${detail})`;
    }),
    '',
    'Revoke one with: /permissions revoke <rule-id>',
  ].join('\n'));
}

async function revokeRememberedRule(ctx: PermissionsCommandContext, ruleId: string): Promise<void> {
  const store = ctx.ruleStore;
  if (!store) {
    ctx.print('Remembered permission rules are not available on this surface.');
    return;
  }
  if (!ruleId) {
    ctx.print('Usage: /permissions revoke <rule-id>  (see /permissions rules for ids)');
    return;
  }
  try {
    const removed = await store.delete(ruleId);
    ctx.print(removed ? `Revoked remembered rule: ${ruleId}` : `No remembered rule with id: ${ruleId}`);
  } catch (error) {
    ctx.print(`Could not revoke the rule: ${summarizeError(error)}`);
  }
}

/** Runs `/permissions [rules | revoke <rule-id>]`. */
export async function runPermissionsCommand(args: readonly string[], ctx: PermissionsCommandContext): Promise<void> {
  const sub = (args[0] ?? '').toLowerCase();
  if (sub === 'rules' || sub === 'rule') {
    showRememberedRules(ctx);
    return;
  }
  if (sub === 'revoke' || sub === 'forget') {
    await revokeRememberedRule(ctx, args[1] ?? '');
    return;
  }
  const provenance = buildPermissionProvenance(ctx.configManager);
  ctx.print(renderPermissionProvenance(provenance));
  const ruleCount = ctx.ruleStore?.list().length ?? 0;
  ctx.print(ruleCount > 0
    ? `\n${ruleCount} remembered approval rule${ruleCount === 1 ? '' : 's'} in effect. Use /permissions rules to review or revoke them.`
    : '\nNo remembered approval rules. Use /permissions rules once you have some.');
}
