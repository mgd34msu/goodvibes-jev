/**
 * PairingTokensSettings, the settings/security surface for per-device pairing
 * tokens (SDK 1.8.0's pairing.tokens.* family), replacing the old single
 * shared token model. Lists every paired device (pairing.tokens.list: name,
 * created, last-seen), the token secret itself is NEVER served here; it is
 * only ever handed back once, at mint time (create/migrate/handoff.create),
 * which is why this list never shows one.
 *
 * Two extra affordances, each with a plain-language description of what it
 * actually does:
 *
 *   - Migrate this browser, mints a fresh, named token for THIS session and
 *     immediately swaps the stored auth token to it (setExplicitAuthToken), so
 *     a browser still relying on the legacy shared token gets its own without
 *     ever being signed out mid-flow.
 *   - Revoke the shared token, a one-way action, gated by a danger confirm
 *     naming the exact consequence (every device still on the shared token is
 *     signed out at once, including this one if it has not migrated yet).
 *     Hidden once legacySharedRevoked is already true, nothing left to revoke.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, RefreshCw, Smartphone, Trash2 } from 'lucide-react';
import { sdk, setExplicitAuthToken } from '../../lib/goodvibes';
import type { PublicPairingToken } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { formatError } from '../../lib/errors';
import { useToast } from '../../lib/toast';
import { Button } from '../ui/Button';
import { useConfirm } from '../ui/ConfirmDialog';
import { Input } from '../ui/Field';
import { IconButton } from '../ui/IconButton';
import { Row, RowList } from '../ui/Row';
import { EmptyState } from '../feedback/EmptyState';
import { ErrorState } from '../feedback/ErrorState';
import { SkeletonBlock } from '../feedback/SkeletonBlock';
import { SettingsBlock } from './dialog/parts';
import { whenLabel } from '../../lib/when-label';
import '../../styles/components/pairing-tokens.css';

export function PairingTokensSettings() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  const tokens = useQuery({
    queryKey: queryKeys.pairingTokens,
    queryFn: () => sdk.operator.pairing.tokens.list(),
  });

  async function invalidateTokens(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: queryKeys.pairingTokens });
  }

  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => sdk.operator.pairing.tokens.rename(id, name),
    onSuccess: async (result) => {
      setEditingId(null);
      if (!result.renamed) {
        toast({ title: 'Rename failed', description: 'The daemon reported no such token.', tone: 'danger' });
      }
      await invalidateTokens();
    },
    onError: (error: unknown) => toast({ title: 'Rename failed', description: formatError(error), tone: 'danger' }),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => sdk.operator.pairing.tokens.delete(id),
    onSuccess: async (result) => {
      toast(
        result.revoked
          ? { title: 'Device revoked', description: 'It will be signed out the next time it tries to connect.', tone: 'info' }
          : { title: 'Already revoked', description: 'The daemon reported no such token.', tone: 'info' },
      );
      await invalidateTokens();
    },
    onError: (error: unknown) => toast({ title: 'Revoke failed', description: formatError(error), tone: 'danger' }),
  });

  const migrate = useMutation({
    mutationFn: (name: string) => sdk.operator.pairing.tokens.migrate(name),
    onSuccess: async (result) => {
      // Swap THIS browser over to its own new token immediately, the daemon just
      // minted it for the same principal, so the swap never signs this tab out.
      await setExplicitAuthToken(result.token.token);
      await invalidateTokens();
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth });
      toast({
        title: 'This browser now has its own token',
        description: `Named "${result.token.name}": it no longer relies on the shared token.`,
        tone: 'success',
      });
    },
    onError: (error: unknown) => toast({ title: 'Migrate failed', description: formatError(error), tone: 'danger' }),
  });

  const revokeShared = useMutation({
    mutationFn: () => sdk.operator.pairing.tokens.revokeShared(),
    onSuccess: async () => {
      toast({ title: 'Shared token revoked', description: 'Any device still using it is now signed out.', tone: 'success' });
      await invalidateTokens();
    },
    onError: (error: unknown) => toast({ title: 'Revoke failed', description: formatError(error), tone: 'danger' }),
  });

  async function handleRevoke(token: PublicPairingToken): Promise<void> {
    const ok = await confirm.ask({
      title: 'Revoke this device?',
      target: token.name,
      description: 'It is signed out now and has to pair again to reconnect.',
      confirmLabel: 'Revoke',
      tone: 'danger',
    });
    if (!ok) return;
    revoke.mutate(token.id);
  }

  async function handleMigrate(): Promise<void> {
    const ok = await confirm.ask({
      title: 'Give this browser its own pairing token?',
      description: 'This browser switches to a new token of its own and stays signed in.',
      confirmLabel: 'Migrate this browser',
    });
    if (!ok) return;
    migrate.mutate('This browser');
  }

  async function handleRevokeShared(): Promise<void> {
    const ok = await confirm.ask({
      title: 'Revoke the shared token?',
      description: 'Every device still using it is signed out now, this browser included if it has no token of its own.',
      confirmLabel: 'Revoke the shared token',
      tone: 'danger',
    });
    if (!ok) return;
    revokeShared.mutate();
  }

  function startRename(token: PublicPairingToken): void {
    setEditingId(token.id);
    setDraftName(token.name);
  }

  function saveRename(id: string): void {
    const name = draftName.trim();
    if (!name) return;
    rename.mutate({ id, name });
  }

  const rows = tokens.data?.tokens ?? [];
  const legacySharedRevoked = tokens.data?.legacySharedRevoked ?? false;

  return (
    <>
      {confirm.element}
      <SettingsBlock
        testId="pairing-tokens"
        title="Devices & pairing"
        description="Every paired phone or browser has its own token. Renaming or revoking one never affects another. A token is shown once, when it is created, so this list never shows one."
        actions={(
          <IconButton
            label="Refresh devices"
            icon={<RefreshCw aria-hidden="true" />}
            disabled={tokens.isFetching}
            onClick={() => void tokens.refetch()}
          />
        )}
      >
        {tokens.isPending && <SkeletonBlock variant="text" lines={3} />}

        {tokens.isError && (
          <ErrorState error={tokens.error} onRetry={() => void tokens.refetch()} title="Failed to load paired devices" />
        )}

        {tokens.isSuccess && rows.length === 0 && (
          <EmptyState
            icon={<Smartphone size={28} />}
            title="No per-device tokens yet"
            description="Pairing a device (goodvibes pair, or the hand-off QR) mints one automatically."
          />
        )}

        {tokens.isSuccess && rows.length > 0 && (
          <RowList aria-label="Paired devices">
            {rows.map((token) => editingId === token.id ? (
              <li key={token.id} className="gv-row pairing-token-row" data-token-id={token.id}>
                <form
                  className="pairing-token-row__rename-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    saveRename(token.id);
                  }}
                >
                  <Input
                    id={`pairing-token-rename-${token.id}`}
                    aria-label="Device name"
                    value={draftName}
                    onChange={(event) => setDraftName(event.target.value)}
                    autoFocus
                  />
                  <Button type="submit" variant="primary" size="sm" disabled={rename.isPending || !draftName.trim()}>
                    Save
                  </Button>
                  <Button size="sm" onClick={() => setEditingId(null)}>
                    Cancel
                  </Button>
                </form>
              </li>
            ) : (
              <Row
                key={token.id}
                className="pairing-token-row"
                title={token.name}
                meta={[
                  whenLabel(token.createdAt) && `Created ${whenLabel(token.createdAt)}`,
                  whenLabel(token.lastSeenAt) ? `last seen ${whenLabel(token.lastSeenAt)}` : 'never seen',
                ].filter(Boolean).join(' · ')}
                trailing={(
                  <>
                    <IconButton
                      label={`Rename ${token.name}`}
                      icon={<Pencil aria-hidden="true" />}
                      onClick={() => startRename(token)}
                    />
                    <Button
                      variant="quiet-danger"
                      size="sm"
                      className="pairing-token-row__revoke"
                      icon={<Trash2 aria-hidden="true" />}
                      disabled={revoke.isPending && revoke.variables === token.id}
                      onClick={() => void handleRevoke(token)}
                    >
                      {revoke.isPending && revoke.variables === token.id ? 'Revoking…' : 'Revoke'}
                    </Button>
                  </>
                )}
              />
            ))}
          </RowList>
        )}
      </SettingsBlock>

      <SettingsBlock
        title="Shared token"
        description={legacySharedRevoked
          ? 'The legacy shared token has been revoked. Every device now needs its own token.'
          : 'Older devices may still be signed in with one shared token. Give each its own token before revoking the shared one, since revoking it signs out anything still using it.'}
      >
        {!legacySharedRevoked && (
          <div className="pairing-tokens-legacy__actions">
            <Button disabled={migrate.isPending} onClick={() => void handleMigrate()}>
              {migrate.isPending ? 'Migrating…' : 'Give this browser its own token'}
            </Button>
            <Button
              variant="danger"
              className="pairing-tokens-legacy__revoke"
              disabled={revokeShared.isPending}
              onClick={() => void handleRevokeShared()}
            >
              {revokeShared.isPending ? 'Revoking…' : 'Revoke the shared token'}
            </Button>
          </div>
        )}
      </SettingsBlock>
    </>
  );
}
