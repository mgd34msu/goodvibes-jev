import type { TelegramSourceAccountReader } from '../channels/telegram/source-account.js';
import type { WorkspaceSwapManagerLike } from './http/system-route-types.js';
/** Real paired-owner command path and daemon adapter composition; no default grant. */
import { DelegatedTelegramIntake } from './delegated-telegram-intake.js';
import type { ResolvedDaemonFacadeRuntime } from './facade-types.js';
import type { GatewayMethodCatalog } from '../control-plane/method-catalog.js';
import type { GatewayMethodInvocation } from '../control-plane/method-catalog-shared.js';
import { GatewayVerbError } from '../control-plane/routes/gateway-verb-error.js';
import { readInvocationParams } from '../control-plane/routes/invocation-params.js';
import { delegatedTelegramResultSchema, delegatedTelegramConfigureSchema, delegatedTelegramDecisionSchema, delegatedTelegramLookupSchema, delegatedTelegramRevokeSchema } from '../control-plane/delegated-inbound-wire.js';
const scopes = ['read:work-ledger', 'write:work-ledger'] as const;
function owner(invocation: GatewayMethodInvocation) {
  const authority = invocation.nativeExecutionAuthority; const current = authority?.current(); const context = invocation.context;
  if (!authority || !current || !context.admin || context.principalKind !== 'token' || context.principalId !== current.principalId
    || current.kind !== 'pairing-token' || current.authorityId !== current.principalId || current.authorityRevision !== current.tokenId
    || !scopes.every(scope => current.scopes.includes('*') || current.scopes.includes(scope)) || invocation.isAuthorized?.(scopes) !== true) {
    throw new GatewayVerbError('Delegated intake requires a current persisted paired owner with work-ledger read/write access.', 'FORBIDDEN', 403);
  }
  return { authority, current };
}
export function registerDelegatedTelegramCommands(catalog: GatewayMethodCatalog, host: DelegatedTelegramIntake): void {
  for (const operation of ['configure', 'decide', 'status', 'revoke', 'list', 'read', 'cancel'] as const) {
    const descriptor = catalog.get(`inbound.telegram.${operation}`);
    if (!descriptor) throw new Error('Missing delegated Telegram command descriptor');
    catalog.register(descriptor, async invocation => {
      const { authority, current } = owner(invocation);
      const input = readInvocationParams(invocation);
      if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 16_384) throw new GatewayVerbError('Oversize command', 'DELEGATED_INTAKE_HELD', 409);
      // Never hold the global paired-owner lock across provider/credential I/O.
      const configuration = operation === 'configure' ? delegatedTelegramConfigureSchema.parse(input) : null;
      const selection = configuration ? await authority.withCurrent(current, async check => { check(); const attempt = await host.selectConfiguration(configuration, authority); check(); return attempt; }) : undefined;
      const needsProof = operation === 'configure' || (operation === 'decide' && delegatedTelegramDecisionSchema.parse(input).approved);
      const prepared = needsProof ? await host.prepareAccount(invocation.signal).catch(() => { throw new GatewayVerbError('Telegram account proof is unavailable or cancelled.', 'DELEGATED_INTAKE_HELD', 409); }) : null;
      invocation.signal?.throwIfAborted(); owner(invocation);
      return authority.withCurrent(current, async assertCurrent => {
        try {
          invocation.signal?.throwIfAborted(); assertCurrent();
          let result: Record<string, unknown>;
          if (operation === 'configure') result = await host.configure(delegatedTelegramConfigureSchema.parse(input), authority, prepared, selection);
          else if (operation === 'decide') result = await host.decide(delegatedTelegramDecisionSchema.parse(input), authority, prepared);
          else if (operation === 'revoke') result = host.revoke(delegatedTelegramRevokeSchema.parse(input).configurationId, authority);
          else if (operation === 'list') { if (Object.keys(input).length) throw new Error('List takes no source payload'); result = await host.list(authority); }
          else { const { ref } = delegatedTelegramLookupSchema.parse(input); result = operation === 'cancel' ? await host.cancel(ref, authority) : await host.status(ref, authority, operation === 'read'); }
          invocation.signal?.throwIfAborted(); assertCurrent(); owner(invocation); return delegatedTelegramResultSchema.parse(result);
        } catch (error) {
          if (error instanceof GatewayVerbError) throw error;
          throw new GatewayVerbError('Delegated Telegram intake is held. Inspect the original source identity; no fallback or replay occurred.', 'DELEGATED_INTAKE_HELD', 409);
        }
      });
    }, { replace: true });
  }
}
export function composeDelegatedTelegramIntake(runtime: ResolvedDaemonFacadeRuntime, accounts: TelegramSourceAccountReader, swapManager: WorkspaceSwapManagerLike | null = null): DelegatedTelegramIntake {
  const workspaceRevision = swapManager?.getWorkspaceRevision?.();
  const host = new DelegatedTelegramIntake({ broker: runtime.sessionBroker, approvals: runtime.approvalBroker, routes: runtime.routeBindings,
    accounts, workspaceRoot: runtime.runtimeServices.workingDirectory,
    isWorkspaceCurrent: () => !swapManager || (typeof swapManager.subscribeBeforeSwap === 'function'
      && typeof swapManager.getWorkspaceRevision === 'function' && swapManager.getWorkspaceRevision() === workspaceRevision
      && swapManager.getCurrentWorkingDir() === runtime.runtimeServices.workingDirectory),
    subscribeWorkspaceInvalidation: invalidate => {
      const beforeSwap = swapManager?.subscribeBeforeSwap?.(invalidate);
      const notice = runtime.runtimeBus.on('WORKSPACE_SWAP_STARTED', invalidate);
      return () => { beforeSwap?.(); notice(); };
    },
    selectionPath: runtime.runtimeServices.shellPaths.resolveProjectPath('goodvibes', 'channels', 'telegram-delegated-selection.json'),
    receiptPath: runtime.runtimeServices.shellPaths.resolveProjectPath('goodvibes', 'channels', 'telegram-delegated-review.json'),
  });
  registerDelegatedTelegramCommands(runtime.gatewayMethods, host); return host;
}
