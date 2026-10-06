import {
  BrowserJudgmentError, missingScopes,
  type AuthenticatedPrincipal, type BrowserJudgmentBatteryId, type BrowserJudgmentErrorSource, type BrowserJudgmentChatSessions,
} from '@goodvibes-jev/engine/daemon-sdk';
import type { GatewayMethodDescriptor } from '../control-plane/method-catalog-shared.js';
import { snapshotJudgmentInput } from '../gate/judgment-input.js';
import { BrowserJudgmentReferences } from './references.js';
import { BrowserJudgmentRegistry } from './registry.js';
import { BrowserJudgmentService } from './service.js';
import type { BrowserJudgmentAuthorization, BrowserJudgmentRoute } from './types.js';
import { createWebuiCommandRankAdapter, webuiDaemonRefusalAdapter } from './batteries/webui-adapters.js';
import { WEBUI_BUILTIN_COMMANDS, WEBUI_COMMAND_CATALOG_VERSION } from './batteries/webui-command-catalog.js';
import { readStructuredDaemonRefusal, snapshotWebuiCommandRank, snapshotWebuiDaemonRefusal } from './batteries/webui-readers.js';
import type { ResolvedCommandCandidate } from './batteries/webui-types.js';

const PALETTE = 'webui.palette.command-rank';
const ERRORS = 'webui.errors.daemon-refusal';
export type WebuiJudgmentSourceKind = 'palette-query' | 'chat-title' | 'daemon-error';

/** Source/purpose permission is owned by the host, separately from read scopes. */
export interface WebuiBrowserJudgmentOptions {
  readonly methods: { get(id: string): GatewayMethodDescriptor | null };
  readonly currentRoute: () => BrowserJudgmentRoute | undefined;
  readonly authorize: (input: BrowserJudgmentAuthorization & { readonly sources: readonly WebuiJudgmentSourceKind[] }) => boolean;
}

const held = (): never => { throw new BrowserJudgmentError('JUDGMENT_REFERENCE_HELD'); };
function canRead(principal: AuthenticatedPrincipal, scopes: readonly string[]): boolean {
  return principal.admin === true || missingScopes(principal.scopes, scopes).length === 0;
}

/**
 * The real WebUI source owner. Only fixed builtin descriptors, host session
 * titles and canonical authenticated failures enter this closed registry.
 * Status enums stay in the pure catalog; no dynamic status issuer is invented.
 */
export function createWebuiBrowserJudgment(options: WebuiBrowserJudgmentOptions): BrowserJudgmentService {
  const references = new BrowserJudgmentReferences();
  const registry = new BrowserJudgmentRegistry();
  const builtins = new Map(WEBUI_BUILTIN_COMMANDS.map((command) => [command.id as string, command]));
  let chatSource: BrowserJudgmentChatSessions | undefined;
  const bindings = new Map<string, { readonly principalId: string; readonly principalKind: AuthenticatedPrincipal['principalKind']; readonly battery: BrowserJudgmentBatteryId;
    readonly sources: readonly WebuiJudgmentSourceKind[] }>();
  const remember = (id: string, principal: AuthenticatedPrincipal, battery: BrowserJudgmentBatteryId,
    sources: readonly WebuiJudgmentSourceKind[]) => {
    try {
      const lease = references.resolve(id, () => principal, battery, (value) => value);
      bindings.set(id, { principalId: principal.principalId, principalKind: principal.principalKind, battery, sources: Object.freeze([...sources]) });
      lease.signal!.addEventListener('abort', () => bindings.delete(id), { once: true });
      return id;
    } catch (error) { references.revoke(id); throw error; }
  };

  registry.register(createWebuiCommandRankAdapter({
    async resolve(input, context) {
      if (input.registryVersion !== WEBUI_COMMAND_CATALOG_VERSION || input.query.kind !== 'inline') return held();
      const initialPrincipal = context.currentPrincipal();
      const { principalId, principalKind } = initialPrincipal;
      const hasChats = input.candidates.some((candidate) => candidate.kind === 'chat');
      const sessions = chatSource;
      const authenticate = () => {
        context.signal.throwIfAborted();
        const principal = context.currentPrincipal();
        if (principal.principalId !== principalId || principal.principalKind !== principalKind || (hasChats && (!sessions || chatSource !== sessions || !canRead(principal, ['read:sessions'])))) return held();
        return principal;
      };
      authenticate();
      const identities = new Set<string>();
      const revisions: { readonly id: string; readonly title: string; readonly createdAt: number; readonly updatedAt: number; readonly identity: WeakRef<object> }[] = [];
      const candidates: ResolvedCommandCandidate[] = [];
      for (const candidate of input.candidates) {
        const identity = candidate.kind === 'builtin' ? `builtin:${candidate.commandId}` : `chat:${candidate.sessionId}`;
        if (identities.has(identity)) return held();
        identities.add(identity);
        if (candidate.kind === 'builtin') {
          const descriptor = builtins.get(candidate.commandId);
          if (!descriptor) return held();
          candidates.push({ title: descriptor.title, group: descriptor.group, keywords: descriptor.keywords });
        } else {
          authenticate();
          const session = sessions!.getSession(candidate.sessionId);
          if (!session || session.id !== candidate.sessionId) return held();
          revisions.push({ id: session.id, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt, identity: new WeakRef(session) });
          candidates.push({ title: session.title, group: 'chats' });
        }
      }
      const assertCurrent = () => {
        authenticate();
        for (const revision of revisions) {
          const current = sessions!.getSession(revision.id);
          if (!current || current !== revision.identity.deref() || current.title !== revision.title || current.createdAt !== revision.createdAt || current.updatedAt !== revision.updatedAt) return held();
        }
        authenticate();
      };
      assertCurrent();
      // Inspect every complete title and the complete query before any call.
      const query = input.query.text;
      const snapshot = (() => {
        try { return snapshotWebuiCommandRank({ query, registryVersion: input.registryVersion, candidates }); }
        catch { throw new BrowserJudgmentError('JUDGMENT_INPUT_HELD'); }
      })();
      const principal = authenticate();
      const id = remember(references.issue({ principalId, battery: PALETTE, revision: crypto.randomUUID(),
        expiresAt: Date.now() + 300_000, snapshot, assertCurrent,
        mayRead: (actor) => actor.principalId === principalId && actor.principalKind === principalKind && (!hasChats || canRead(actor, ['read:sessions'])),
      }), principal, PALETTE, hasChats ? ['palette-query', 'chat-title'] : ['palette-query']);
      try {
        return { ...references.resolve(id, context.currentPrincipal, PALETTE, snapshotWebuiCommandRank),
          dispose: () => references.revoke(id) };
      } catch (error) { references.revoke(id); throw error; }
    },
  }));
  registry.register(webuiDaemonRefusalAdapter);

  const issueErrorReference = ({ principal, methodId, status, body }: BrowserJudgmentErrorSource): string | undefined => {
    try {
      if (!canRead(principal, ['write:judgment']) || status < 400 || status > 599) return undefined;
      const method = options.methods.get(methodId);
      if (!method || method.access === 'remote-peer' || (method.access === 'admin' && !principal.admin)
        || !canRead(principal, method.scopes)) return undefined;
      const scopes = Object.freeze([...method.scopes]);
      const access = method.access;
      // The canonical response is inspected in full before selecting its
      // bounded original error message. No stack, URL, header or payload is
      // staged by the browser, and no returned errorRef is ever trusted.
      const source = snapshotJudgmentInput(body);
      if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
      const fields = source as Record<string, unknown>;
      const message = typeof fields['error'] === 'string' ? fields['error'] : fields['message'];
      const snapshot = snapshotWebuiDaemonRefusal({ methodId, status, message,
        ...(typeof fields['code'] === 'string' ? { code: fields['code'] } : {}),
        ...(fields['category'] === 'network' || fields['category'] === 'authentication' ? { category: fields['category'] } : {}),
      });
      if (!snapshot.message.trim() || readStructuredDaemonRefusal(snapshot) !== undefined) return undefined;
      const assertCurrent = () => {
        if (options.methods.get(methodId) !== method || method.access !== access || method.scopes.length !== scopes.length
          || method.scopes.some((scope, index) => scope !== scopes[index])) return held();
      };
      return remember(references.issue({ principalId: principal.principalId, battery: ERRORS,
        revision: crypto.randomUUID(), expiresAt: Date.now() + 300_000, snapshot, assertCurrent,
        mayRead: (actor) => actor.principalKind === principal.principalKind && canRead(actor, ['write:judgment', ...scopes]) && (access !== 'admin' || actor.admin),
      }), principal, ERRORS, ['daemon-error']);
    } catch { return undefined; }
  };
  return new BrowserJudgmentService({ registry, references, currentRoute: options.currentRoute, issueErrorReference,
    bindChatSessions(source) {
      const invalidate = () => {
        for (const [id, binding] of bindings) if (binding.sources.includes('chat-title')) references.revoke(id);
      };
      invalidate();
      chatSource = source;
      return () => { if (chatSource === source) { chatSource = undefined; invalidate(); } };
    },
    authorize(input) {
      const binding = bindings.get(input.sourceBinding);
      return !!binding && binding.principalId === input.principal.principalId && binding.principalKind === input.principal.principalKind && binding.battery === input.battery
        && options.authorize({ ...input, sources: binding.sources }) === true;
    },
  });
}
