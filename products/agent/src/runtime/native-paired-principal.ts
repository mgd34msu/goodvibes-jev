import type { OperatorMethodOutput } from '@goodvibes-jev/engine/sdk/contracts';

/** The live authority required by native intake, not the coarse authMode label. */
export function isNativePairedPrincipal(auth: OperatorMethodOutput<'control.auth.current'>): boolean {
  return auth.authenticated === true && auth.admin === true && auth.principalKind === 'token'
    && typeof auth.principalId === 'string' && auth.principalId.length > 0 && auth.principalId.length <= 200
    && auth.principalId !== 'shared-token'
    && Array.isArray(auth.scopes)
    && ['read:work-ledger', 'write:work-ledger'].every(scope => auth.scopes.includes('*') || auth.scopes.includes(scope));
}
