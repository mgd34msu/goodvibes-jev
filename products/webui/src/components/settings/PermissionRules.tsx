/**
 * Approval rules, in Settings > Permissions: every decision remembered at a
 * generalizing tier (permissions.rules.list), with revocation
 * (permissions.rules.delete). Rules are only minted by decisions (an approval
 * with a Remember scope); deleting one makes matching asks prompt again. A
 * `deleted:false` answer is the daemon's honest "no such rule" (already gone),
 * reported as information, not an error.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Trash2 } from 'lucide-react';
import { sdk } from '../../lib/goodvibes';
import type { PermissionRuleRecord } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { formatError } from '../../lib/errors';
import { useToast } from '../../lib/toast';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { Row, RowList } from '../ui/Row';
import { StatusDot } from '../ui/StatusDot';
import { SettingsBlock } from './dialog/parts';
import { whenLabel } from '../../lib/when-label';

/** One-line reading of a rule: effect, tier, tool. */
export function ruleSummary(rule: PermissionRuleRecord): string {
  const effect = rule.effect === 'deny' ? 'Deny' : 'Allow';
  return `${effect} · ${rule.tier} · ${rule.tool}`;
}

export function PermissionRules() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const rules = useQuery({
    queryKey: queryKeys.permissionRules,
    queryFn: () => sdk.operator.permissions.rules.list(),
  });
  const remove = useMutation({
    mutationFn: (ruleId: string) => sdk.operator.permissions.rules.delete(ruleId),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.permissionRules });
      toast(result.deleted
        ? { title: 'Rule deleted', description: 'Matching asks will prompt again.', tone: 'info' }
        : { title: 'Rule already gone', description: 'The daemon reported no such rule.', tone: 'info' });
    },
    onError: (error: unknown) => toast({ title: 'Delete failed', description: formatError(error), tone: 'danger' }),
  });
  const rows = rules.data?.rules ?? [];

  return (
    <SettingsBlock
      title="Approval rules"
      description="Approving with a Remember scope (exact command, command class, path or tool) records a rule here. Delete one and matching asks prompt again."
      actions={<IconButton label="Refresh rules" icon={<RefreshCw />} onClick={() => void rules.refetch()} />}
      testId="permission-rules"
    >
      {rules.isPending && <p className="settings-empty">Loading rules…</p>}
      {rules.isError && (
        <p className="settings-empty" role="alert">
          Could not load approval rules: {formatError(rules.error)}{' '}
          <Button size="sm" variant="ghost" onClick={() => void rules.refetch()}>Retry</Button>
        </p>
      )}
      {rules.isSuccess && rows.length === 0 && <p className="settings-empty">No approval rules yet.</p>}
      {rows.length > 0 && (
        <RowList aria-label="Approval rules">
          {rows.map((rule) => (
            <Row
              key={rule.id}
              className="permission-rule-row"
              leading={<StatusDot tone={rule.effect === 'deny' ? 'bad' : 'ok'} srLabel={rule.effect} />}
              title={ruleSummary(rule)}
              meta={[rule.description ?? '', whenLabel(rule.createdAt) && `created ${whenLabel(rule.createdAt)}`].filter(Boolean).join(' · ')}
              trailing={(
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Trash2 aria-hidden="true" />}
                  disabled={remove.isPending && remove.variables === rule.id}
                  aria-label={`Delete rule: ${ruleSummary(rule)}`}
                  title="Delete this rule: matching asks will prompt again"
                  onClick={() => remove.mutate(rule.id)}
                >
                  {remove.isPending && remove.variables === rule.id ? 'Deleting…' : 'Delete'}
                </Button>
              )}
            />
          ))}
        </RowList>
      )}
    </SettingsBlock>
  );
}
