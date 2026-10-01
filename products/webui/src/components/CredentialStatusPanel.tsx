/**
 * CredentialStatusPanel, the display-site adoption of the cross-surface
 * credential-status facade (src/lib/provider-status.ts: deriveCredentialAvailability
 * over `sdk.operator.credentials.get`). The facade shipped in 1.0.1 with zero
 * consumers; this is the reference implementation the audit calls for, so the
 * pattern here is what the TUI/agent can later mirror.
 *
 * Renders three honest outcomes, never a fourth fabricated one:
 *   1. REFUSED, the admin-scoped `credentials.get` route 403s a non-admin
 *      token (control-plane.ts requireAdmin: `{error: 'Admin role required'}`,
 *      no machine `code`). Distinguished from (2) so "you can't see this" never
 *      reads as "the store is broken".
 *   2. DEGRADED, deriveCredentialAvailability's `available: false` states: a
 *      503 CREDENTIAL_STORE_UNAVAILABLE, a METHOD_NOT_FOUND from an older
 *      daemon, or any transport failure. The reason is the facade's own text,
 *      never invented here.
 *   3. AVAILABLE, the credential list, each entry rendered as
 *      configured+usable ("usable"), configured-but-not-usable ("configured,
 *      not usable", the honest degraded ref, distinct from a fault), or
 *      unconfigured ("not configured"). CredentialStatusEntry carries no
 *      secret value field by construction (see provider-status.ts), this
 *      component only ever reads key/configured/usable/source/secure.
 */
import { useQuery } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import type { StatusTone } from './ui/StatusDot';
import { sdk } from '../lib/goodvibes';
import { deriveCredentialAvailability, type CredentialStatusEntry } from '../lib/provider-status';
import { errorCode, serializeError } from '../lib/errors';
import { EmptyState } from './feedback/EmptyState';
import { SkeletonBlock } from './feedback/SkeletonBlock';
import { Chip } from './ui/Chip';
import { Row, RowList } from './ui/Row';
import { SettingsBlock } from './settings/dialog/parts';
import '../styles/components/providers.css';

/**
 * True for the daemon's 403 admin-scope refusal on the admin-only
 * `credentials.get` route. Checked BEFORE deriveCredentialAvailability so a
 * non-admin token renders an honest "admin access required" message instead
 * of falling into the facade's generic "unavailable right now" catch-all,
 * both are honest (neither fabricates "configured"), but this one names the
 * actual cause. The wire shape carries no machine `code` for this refusal
 * (control-plane.ts's requireAdmin returns `{error: 'Admin role required'}`,
 * status 403 only), so this checks status, not code.
 */
function isAdminRequiredError(error: unknown): boolean {
  const serialized = serializeError(error);
  const transport = serialized.transport as Record<string, unknown> | undefined;
  const status =
    typeof serialized.status === 'number'
      ? serialized.status
      : typeof transport?.status === 'number'
        ? transport.status
        : undefined;
  return status === 403;
}

function credentialTone(entry: CredentialStatusEntry): StatusTone {
  if (!entry.configured) return 'idle';
  return entry.usable ? 'ok' : 'warn';
}

function credentialLabel(entry: CredentialStatusEntry): string {
  if (!entry.configured) return 'not configured';
  return entry.usable ? 'usable' : 'configured, not usable';
}

export interface CredentialStatusPanelProps {
  /**
   * The currently selected provider id, if any, used only for a soft,
   * best-effort enrichment: a credential key containing the provider id
   * (case-insensitive) is highlighted as "for this provider". No match means
   * no highlight; this never fabricates a link the wire didn't report.
   */
  selectedProviderId?: string;
}

export function CredentialStatusPanel({ selectedProviderId }: CredentialStatusPanelProps) {
  const query = useQuery({
    queryKey: ['credentials'],
    queryFn: () => sdk.operator.credentials.get(),
    retry: false,
  });

  const refused = query.isError && isAdminRequiredError(query.error);
  const availability =
    query.isSuccess
      ? deriveCredentialAvailability({ ok: true, value: query.data })
      : query.isError && !refused
        ? deriveCredentialAvailability({ ok: false, error: { code: errorCode(query.error) } })
        : null;
  // Flattened once here (rather than repeated `availability && availability.available`
  // chains in the JSX below) so the discriminated union narrows cleanly and the
  // optional-chain lint rule has nothing to flag.
  const degradedReason = availability?.available === false ? availability.reason : null;
  const credentials = availability?.available === true ? availability.credentials : null;

  return (
    <SettingsBlock className="credential-status" title="Credential status">
      {query.isPending ? (
        <div className="credential-status__skeleton" aria-label="Loading credential status" aria-busy="true">
          {Array.from({ length: 3 }, (_, i) => (
            <SkeletonBlock key={i} variant="block" height={36} />
          ))}
        </div>
      ) : refused ? (
        <div className="credential-status__degraded" role="status">
          <strong>Admin access required</strong>
          <span>Sign in with an admin-scoped token to view credential status.</span>
        </div>
      ) : degradedReason !== null ? (
        <div className="credential-status__degraded" role="status">
          <strong>Credential status unavailable</strong>
          <span>{degradedReason}</span>
        </div>
      ) : credentials !== null && credentials.length === 0 ? (
        <EmptyState
          icon={<KeyRound size={24} aria-hidden="true" />}
          title="No credentials"
          description="No credential status reported by the daemon."
        />
      ) : credentials !== null ? (
        <RowList aria-label="Credentials">
          {credentials.map((entry) => {
            const matched = Boolean(
              selectedProviderId && entry.key.toLowerCase().includes(selectedProviderId.toLowerCase()),
            );
            return (
              <Row
                key={entry.key}
                selected={matched}
                title={<span className="credential-status__key">{entry.key}</span>}
                meta={`${entry.source ?? 'source unknown'}${matched ? ' · for the selected provider' : ''}`}
                trailing={<Chip tone={credentialTone(entry)}>{credentialLabel(entry)}</Chip>}
              />
            );
          })}
        </RowList>
      ) : null}
    </SettingsBlock>
  );
}
