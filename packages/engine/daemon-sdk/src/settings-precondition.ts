/**
 * A bounded same-serving-owner precondition for the adopted SETTINGS HTTP lane.
 * This is neither a Jev grant nor persisted-file CAS. Existing persistence stays
 * last-writer-wins. The caller still needs its authentic manager/registry act.
 */
export interface SettingsPreconditionRequest {
  readonly operation: 'set' | 'reset-default';
  readonly key: string;
  readonly value?: unknown;
  /** Remove only this setting's derived credential in its owning scope. */
  readonly credentialClear?: true;
}
export interface SettingsPreconditionFacts extends SettingsPreconditionRequest {
  readonly value: unknown;
  readonly destinations: readonly { readonly path: string; readonly operation: 'set' | 'remove'; readonly tier: string }[];
  readonly incarnation: number;
  readonly credential?: {
    readonly key: string;
    readonly scope: 'daemon' | 'user';
    readonly destinations: readonly { readonly path: string; readonly operation: 'remove'; readonly tier: string }[];
  };
}
export interface SettingsPreconditionReceipt {
  readonly status: 'committed' | 'partial' | 'unknown';
  readonly completedPaths: readonly string[];
  readonly uncertainPath?: string;
  /** Reporting only, required on committed wire receipts. Failure never undoes publication. */
  readonly verifiedInOwningStore?: boolean;
}
export interface SettingsPreconditionHandler {
  /** Capture before the body await so stop/rebind/token ABA cannot cross it. */
  lifetime(): object | null;
  handle(req: Request, payload: Record<string, unknown>, requestLifetime: object | null): Response | Promise<Response>;
}
interface Options<Prepared, Transition, Authority> {
  readonly owner: {
    prepare(request: SettingsPreconditionRequest): Prepared;
    inspect(prepared: Prepared): SettingsPreconditionFacts;
    assert(prepared: Prepared): void;
    begin(prepared: Prepared): Transition;
    assertTransition(prepared: Prepared, transition: Transition): void;
    finish(prepared: Prepared, transition: Transition, assertCurrent: () => void): SettingsPreconditionReceipt;
    /** Acquire physical ownership before entering the synchronous auth/effect tail. */
    withPrepared?<T>(prepared: Prepared, operation: () => T): Promise<T>;
  };
  readonly lifetime: () => object | null;
  readonly captureAuthority: (req: Request) => Authority | null;
  readonly withAuthority: <T>(req: Request, authority: Authority, callback: (assertCurrent: () => void) => T) => T;
}
// Five minutes permits ordinary recorded admission reads. Bounded in both time
// and count; capture never starts a timer, and neither arm refreshes a reference.
const LIFETIME_MS = 5 * 60_000;
const MAX_REFERENCES = 256;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.length && keys.every(key => fields.includes(key));
}
function refusal(status: number, code: string): Response {
  // Never echo body, normalized values, credentials, paths or owner errors.
  return Response.json({ error: 'Settings owner precondition unavailable', code }, { status });
}
export function createSettingsPreconditionHandler<Prepared, Transition, Authority>(
  options: Options<Prepared, Transition, Authority>,
): SettingsPreconditionHandler {
  const references = new Map<string, { prepared: Prepared; authority: Authority; lifetime: object; expiresAt: number }>();
  let servingLifetime: object | null = null;
  const synchronize = (): object | null => {
    const current = options.lifetime();
    if (current !== servingLifetime) { references.clear(); servingLifetime = current; }
    const now = Date.now();
    for (const [reference, entry] of references) if (entry.expiresAt <= now) references.delete(reference);
    return current;
  };
  return {
    lifetime: options.lifetime,
    handle(req, payload, requestLifetime) {
      const arm = payload.settingsPrecondition;
      if (!exact(payload, ['settingsPrecondition']) || !record(arm) || arm.version !== 1) {
        return refusal(400, 'SETTINGS_PRECONDITION_INVALID');
      }
      if (arm.action === 'capture') {
        const fields = arm.operation === 'set' ? ['version', 'action', 'operation', 'key', 'value'] : ['version', 'action', 'operation', 'key'];
        if (Object.hasOwn(arm, 'credentialClear')) fields.push('credentialClear');
        if (!exact(arm, fields) || (Object.hasOwn(arm, 'credentialClear') && arm.credentialClear !== true) || (arm.operation !== 'set' && arm.operation !== 'reset-default')
          || typeof arm.key !== 'string' || !arm.key || arm.key === 'runtime.workingDir') return refusal(400, 'SETTINGS_PRECONDITION_INVALID');
        const lifetime = synchronize();
        if (lifetime === null || lifetime !== requestLifetime) return refusal(409, 'SETTINGS_PRECONDITION_STALE');
        try {
          const prepared = options.owner.prepare({ operation: arm.operation, key: arm.key, ...(arm.operation === 'set' ? { value: arm.value } : {}), ...(arm.credentialClear === true ? { credentialClear: true } : {}) });
          const facts = options.owner.inspect(prepared);
          options.owner.assert(prepared);
          // Preparation is read-only but may validate. Capture current authority
          // after it, rather than accepting authority observed before callbacks.
          const authority = options.captureAuthority(req);
          if (authority === null || options.lifetime() !== lifetime) return refusal(409, 'SETTINGS_PRECONDITION_STALE');
          const reference = crypto.randomUUID();
          const expiresAt = Date.now() + LIFETIME_MS;
          while (references.size >= MAX_REFERENCES) references.delete(references.keys().next().value!);
          references.set(reference, { prepared, authority, lifetime, expiresAt });
          return Response.json({ settingsPrecondition: { version: 1, action: 'captured', reference, expiresAt, facts } });
        } catch { return refusal(409, 'SETTINGS_PRECONDITION_UNAVAILABLE'); }
      }
      if (arm.action !== 'apply' || !exact(arm, ['version', 'action', 'reference'])
        || typeof arm.reference !== 'string' || !arm.reference || arm.reference.length > 128) return refusal(400, 'SETTINGS_PRECONDITION_INVALID');
      const lifetime = synchronize();
      const entry = references.get(arm.reference);
      // One use, including auth/currentness refusal. No same-reference retry.
      references.delete(arm.reference);
      if (!entry || lifetime === null || lifetime !== requestLifetime || entry.lifetime !== lifetime || entry.expiresAt <= Date.now()) {
        return refusal(409, 'SETTINGS_PRECONDITION_STALE');
      }
      const apply = (): Response => { try {
        const receipt = options.withAuthority(req, entry.authority, (assertCurrent) => {
          const assertBound = () => { assertCurrent(); if (options.lifetime() !== entry.lifetime || Date.now() >= entry.expiresAt) throw new Error('stale'); };
          assertBound();
          options.owner.assert(entry.prepared);
          const transition = options.owner.begin(entry.prepared);
          // begin performs all validators/invalidation subscribers. Final auth,
          // exact owner transition and lifetime checks precede callback-free I/O.
          assertBound();
          options.owner.assertTransition(entry.prepared, transition);
          if (options.lifetime() !== entry.lifetime || Date.now() >= entry.expiresAt) throw new Error('stale');
          return options.owner.finish(entry.prepared, transition, assertBound);
        });
        // No post-effect auth assertion can turn a completed mutation into a
        // refusal. Only the physical owner's truthful receipt is acknowledged.
        return Response.json({ settingsPrecondition: { version: 1, action: 'applied', reference: arm.reference, receipt } });
      } catch { return refusal(409, 'SETTINGS_PRECONDITION_UNAVAILABLE'); } };
      return options.owner.withPrepared
        ? options.owner.withPrepared(entry.prepared, apply).catch(() => refusal(409, 'SETTINGS_PRECONDITION_UNAVAILABLE'))
        : apply();
    },
  };
}
