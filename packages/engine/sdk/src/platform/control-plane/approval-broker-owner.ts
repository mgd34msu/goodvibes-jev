import type { PermissionPromptDecision } from '../permissions/prompt.js';
import type { RememberTier } from '../permissions/approval-rules.js';
import { assertPermissionActive } from '../permissions/cancellation.js';
import { assertExplicitApprovalDisposition, type ExplicitApprovalDisposition } from './approval-disposition.js';
import type { RequestSharedApprovalInput, SharedApprovalRecord } from './approval-broker.js';
import { raiseSharedApproval, type RaiseApprovalDeps, type RaisedApproval } from './approval-broker-raise.js';
import { logger } from '../utils/logger.js';

/** In-process source/lifetime checks, never accepted from an approval's metadata. */
export interface OwnerApprovalGuard {
  readonly assertCurrent: () => void;
  /** Required to permit exact, host-validated modifications such as retention choice. */
  readonly validateDecision?: ((decision: PermissionPromptDecision) => void) | undefined;
}

export interface ResolveSharedApprovalInput {
  readonly approved: boolean;
  readonly disposition?: ExplicitApprovalDisposition | undefined;
  readonly remember?: boolean | undefined;
  readonly modifiedArgs?: Record<string, unknown> | undefined;
  readonly selectedHunks?: readonly number[] | undefined;
  readonly rememberTier?: RememberTier | undefined;
  readonly reason?: string | undefined;
  readonly actor: string;
  readonly actorSurface?: string | undefined;
  readonly note?: string | undefined;
}

export interface ResolveOwnerApprovalInput {
  readonly decision: PermissionPromptDecision;
  readonly actor: string;
  readonly actorSurface?: string | undefined;
  /** The dedicated host route verifies its currently paired owner here. */
  readonly assertCurrent: () => void;
}

export interface RaisedOwnerApproval extends RaisedApproval {
  /** Host-private capability. Never serialize, publish, or store this function. */
  readonly resolveOwnerDecision: (input: ResolveOwnerApprovalInput) => Promise<SharedApprovalRecord | null>;
}

export interface OwnerApprovalProof {
  readonly token: symbol;
  readonly assertCurrent: () => void;
}

interface OwnerCapability {
  readonly token: symbol;
  readonly guard: OwnerApprovalGuard;
  resolving?: boolean;
}

type OwnerApprovalDeps = RaiseApprovalDeps & {
  resolve(id: string, input: ResolveSharedApprovalInput, proof?: OwnerApprovalProof): Promise<SharedApprovalRecord | null>;
};

function invalidOwnerDecision(): never {
  throw Object.assign(new Error('This approval requires its exact current owner decision.'), {
    code: 'INVALID_ARGUMENT', status: 400,
  });
}

function exactDecision(value: PermissionPromptDecision, guard: OwnerApprovalGuard): PermissionPromptDecision {
  if (!value || typeof value !== 'object'
    || Object.keys(value).some((key) => !['approved', 'remember', 'rememberTier', 'reason', 'modifiedArgs'].includes(key))
    || (value.remember !== undefined && value.remember !== false)
    || value.rememberTier !== undefined
    || (value.reason !== undefined && typeof value.reason !== 'string')
    || (value.modifiedArgs !== undefined && !guard.validateDecision)) invalidOwnerDecision();
  assertExplicitApprovalDisposition(value.approved, undefined);
  const decision = structuredClone(value);
  guard.validateDecision?.(decision);
  // Validators inspect choices; they cannot turn a one-shot ask into a rule.
  if (decision.remember || decision.rememberTier !== undefined) invalidOwnerDecision();
  return { ...decision, remember: false };
}

/** Tokens are scoped to one broker and ask, and disappear on restart or settlement. */
export class OwnerApprovalAuthority {
  readonly #capabilities = new Map<string, OwnerCapability>();

  async raise(input: RequestSharedApprovalInput, deps: OwnerApprovalDeps): Promise<RaisedApproval> {
    const guard = input.requireOwnerDecision;
    if (guard !== undefined && (!guard || typeof guard.assertCurrent !== 'function'
      || (guard.validateDecision !== undefined && typeof guard.validateDecision !== 'function'))) invalidOwnerDecision();
    const sourceAssert = guard?.assertCurrent.bind(guard);
    const sourceValidate = guard?.validateDecision?.bind(guard);
    const signal = input.signal;
    const ownedGuard: OwnerApprovalGuard | undefined = sourceAssert ? {
      assertCurrent: () => { assertPermissionActive(signal); sourceAssert(); },
      validateDecision: sourceValidate,
    } : undefined;
    const ownedInput = ownedGuard ? {
      ...input,
      request: structuredClone(input.request),
      metadata: input.metadata === undefined ? undefined : structuredClone(input.metadata),
      requireOwnerDecision: ownedGuard,
    } : input;
    const raised = await raiseSharedApproval(ownedInput, deps);
    const pending = deps.pendingResolvers.get(raised.approval.id);
    const capability = ownedGuard ? { token: Symbol('owner-approval'), guard: ownedGuard } : undefined;
    if (capability && pending && !pending.retired) this.#capabilities.set(raised.approval.id, capability);
    const resolveOwnerDecision = capability ? async (resolution: ResolveOwnerApprovalInput): Promise<SharedApprovalRecord | null> => {
      if (typeof resolution.assertCurrent !== 'function') invalidOwnerDecision();
      const assertCurrent = resolution.assertCurrent;
      capability.guard.assertCurrent();
      assertCurrent();
      const decision = exactDecision(resolution.decision, capability.guard);
      return deps.resolve(raised.approval.id, {
        ...decision,
        disposition: decision.approved ? 'approved' : 'denied',
        actor: resolution.actor,
        actorSurface: resolution.actorSurface,
      }, { token: capability.token, assertCurrent });
    } : undefined;
    // A wire caller serializing a raised result must never export this capability.
    if (resolveOwnerDecision) Object.defineProperty(raised, 'resolveOwnerDecision', { value: resolveOwnerDecision });
    if (input.localPrompt && !raised.coalesced && !pending?.retired
      && (raised.approval.status === 'pending' || raised.approval.status === 'claimed')) {
      const localPrompt = input.localPrompt;
      const actor = input.localPromptActor ?? 'tui-local';
      const actorSurface = input.localPromptSurface ?? 'tui';
      void Promise.resolve().then(() => {
        ownedGuard?.assertCurrent();
        return localPrompt(ownedInput.request, { signal: pending?.promptController?.signal });
      }).then((decision) => resolveOwnerDecision
        ? resolveOwnerDecision({ decision, actor, actorSurface, assertCurrent: ownedGuard!.assertCurrent })
        : deps.resolve(raised.approval.id, { ...decision, actor, actorSurface }))
        .catch(async (error: unknown) => {
          // Source/owner errors may contain private context. Persist a fixed note.
          if (ownedGuard) await deps.cancel(raised.approval.id).catch(() => undefined);
          logger.warn('Local approval prompt failed', {
            approvalId: raised.approval.id,
            error: ownedGuard ? 'owner approval is no longer valid' : error instanceof Error ? error.message : String(error),
          });
        });
    }
    return raised;
  }

  /** Called before mutation and after each awaited store boundary. */
  check(approval: SharedApprovalRecord, input: ResolveSharedApprovalInput, proof?: OwnerApprovalProof): (() => void) | undefined {
    if (!approval.requiresOwnerDecision || !input.approved) return undefined;
    const capability = this.#capabilities.get(approval.id);
    if (!capability || !proof || capability.token !== proof.token || capability.resolving) invalidOwnerDecision();
    if (input.remember === true || input.rememberTier !== undefined || input.selectedHunks !== undefined) invalidOwnerDecision();
    const assertCurrent = (): void => {
      if (this.#capabilities.get(approval.id) !== capability
        || (approval.expiresAt !== undefined && approval.expiresAt <= Date.now())) invalidOwnerDecision();
      capability.guard.assertCurrent();
      proof.assertCurrent();
    };
    assertCurrent();
    capability.resolving = true;
    return assertCurrent;
  }

  retire(approvalId: string): void { this.#capabilities.delete(approvalId); }
}
