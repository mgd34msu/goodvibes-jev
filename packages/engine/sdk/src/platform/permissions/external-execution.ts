/** Explicit workspace constraints stay live until the actual protocol effect. */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ExternalPermissionHost } from './external-request.js';

/** Capture revision only: the canonical manager still owns action classification. */
export async function prepareExternalWorkspaceRevision(host: ExternalPermissionHost, signal: AbortSignal): Promise<() => void> {
  const trust = host.workspaceTrust;
  const prepare = trust?.prepareAutonomousConstraint;
  const root = host.workspaceRoot;
  if (trust === undefined || (trust !== null && typeof prepare !== 'function')) throw new Error('External operation has no workspace trust owner');
  const physical = root ? realpathSync(resolve(root)) : undefined;
  const assertTrust = await prepare?.call(trust, 'read', signal);
  const assertCurrent = () => {
    signal.throwIfAborted(); host.signal.throwIfAborted(); assertTrust?.();
    if (host.workspaceTrust !== trust || trust?.prepareAutonomousConstraint !== prepare || host.workspaceRoot !== root
      || (root && realpathSync(resolve(root)) !== physical)) throw new Error('External workspace ownership changed');
  };
  assertCurrent(); return assertCurrent;
}

/** Process start retains both the original owner's and actual target's bounds. */
export async function prepareExternalExecution(host: ExternalPermissionHost, cwd: string, signal: AbortSignal): Promise<() => void> {
  const origin = host.workspaceTrust;
  const resolver = host.workspaceTrustFor;
  const root = host.workspaceRoot;
  if (origin === undefined) throw new Error('External process has no workspace trust owner');
  const target = resolver ? resolver(cwd) : origin;
  if (target === undefined) throw new Error('External process target has no workspace trust owner');
  const physical = realpathSync(resolve(cwd));
  const originPhysical = root ? realpathSync(resolve(root)) : undefined;
  if (!resolver && origin !== null && (!root || realpathSync(resolve(root)) !== physical))
    throw new Error('External process target differs from its workspace trust owner');
  const originPrepare = origin?.prepareAutonomousConstraint;
  const targetPrepare = target?.prepareAutonomousConstraint;
  if ((origin !== null && typeof originPrepare !== 'function') || (target !== null && typeof targetPrepare !== 'function'))
    throw new Error('External process workspace trust capability is unavailable');
  const originPreparation = originPrepare?.call(origin, 'execute', signal);
  const targetPreparation = target === origin ? originPreparation : targetPrepare?.call(target, 'execute', signal);
  const [originCurrent, targetCurrent] = await Promise.all([originPreparation, targetPreparation]);
  const assertCurrent = () => {
    signal.throwIfAborted(); host.signal.throwIfAborted(); originCurrent?.(); targetCurrent?.();
    if (host.workspaceTrust !== origin || host.workspaceTrustFor !== resolver || host.workspaceRoot !== root
      || origin?.prepareAutonomousConstraint !== originPrepare || target?.prepareAutonomousConstraint !== targetPrepare
      || (resolver && resolver(cwd) !== target) || realpathSync(resolve(cwd)) !== physical
      || (root && realpathSync(resolve(root)) !== originPhysical))
      throw new Error('External process workspace ownership changed');
  };
  assertCurrent(); return assertCurrent;
}
