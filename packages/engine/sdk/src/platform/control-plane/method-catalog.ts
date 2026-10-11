import { builtinDelegatedInboundMethodDescriptors } from './method-catalog-delegated-inbound.js';
import { builtinGatewayNativeHostedTurnMethodDescriptors } from './method-catalog-native-hosted-turn.js';
import { builtinGatewayNativeConversationIntakeMethodDescriptors } from './method-catalog-native-intake.js';
import { builtinGatewayNativeWorkSubmissionMethodDescriptors } from './method-catalog-native-work-submission.js';
import { builtinGatewayWorkLedgerMethodDescriptors } from './method-catalog-work-ledger.js';
import { builtinGatewayNativeWorkExecutionMethodDescriptors } from './method-catalog-native-work-execution.js';
import { builtinBrowserJudgmentMethodDescriptors } from './method-catalog-browser-judgment.js';
import {
  builtinGatewayAdminMethodDescriptors,
} from './method-catalog-admin.js';
import {
  builtinGatewayChannelMethodDescriptors,
} from './method-catalog-channels.js';
import {
  builtinGatewayChannelTestMethodDescriptors,
} from './method-catalog-channels-test.js';
import {
  builtinGatewayCostMethodDescriptors,
} from './method-catalog-cost.js';
import {
  builtinGatewayPermissionRuleMethodDescriptors,
} from './method-catalog-permission-rules.js';
import {
  builtinGatewayControlMethodDescriptors,
} from './method-catalog-control.js';
import {
  builtinGatewayEmailMethodDescriptors,
} from './method-catalog-email.js';
import { builtinGatewayPaymentsMethodDescriptors } from './method-catalog-payments.js';
import {
  builtinGatewayCalendarMethodDescriptors,
} from './method-catalog-calendar.js';
import {
  builtinGatewayBrowserMethodDescriptors,
} from './method-catalog-browser.js';
import {
  builtinGatewayEventDescriptors,
} from './method-catalog-events.js';
import {
  builtinGatewayKnowledgeMethodDescriptors,
} from './method-catalog-knowledge.js';
import {
  builtinGatewayMediaMethodDescriptors,
} from './method-catalog-media.js';
import {
  builtinGatewayPushMethodDescriptors,
} from './method-catalog-push.js';
import {
  builtinGatewayPairingMethodDescriptors,
} from './method-catalog-pairing.js';
import {
  builtinGatewayTailscaleMethodDescriptors,
} from './method-catalog-tailscale.js';
import {
  builtinGatewayAcpMethodDescriptors,
} from './method-catalog-acp.js';
import type {
  GatewayEventDescriptor,
  GatewayEventListOptions,
  GatewayMethodDescriptor,
  GatewayMethodHandler,
  GatewayMethodInvocation,
  GatewayMethodListOptions,
} from './method-catalog-shared.js';
import {
  builtinGatewayRuntimeMethodDescriptors,
} from './method-catalog-runtime.js';
import {
  builtinGatewayModelMethodDescriptors,
} from './method-catalog-models.js';
import {
  builtinGatewayUpdateMethodDescriptors,
} from './method-catalog-update.js';
import {
  builtinGatewayRelayMethodDescriptors,
} from './method-catalog-relay.js';
import {
  builtinGatewayPrincipalsMethodDescriptors,
} from './method-catalog-principals.js';
import {
  builtinGatewayOwnerProfileMethodDescriptors,
} from './method-catalog-owner-profile.js';
import {
  builtinGatewayOccasionsMethodDescriptors,
} from './method-catalog-occasions.js';
import {
  builtinGatewayChannelProfilesMethodDescriptors,
} from './method-catalog-channel-profiles.js';
import {
  builtinGatewayCheckinMethodDescriptors,
} from './method-catalog-checkin.js';
import {
  builtinGatewayCiMethodDescriptors,
} from './method-catalog-ci.js';
import {
  builtinGatewaySkillsMethodDescriptors,
} from './method-catalog-skills.js';
import {
  builtinGatewayFlagsMethodDescriptors,
} from './method-catalog-flags.js';
import {
  builtinGatewayRewindMethodDescriptors,
} from './method-catalog-rewind.js';
import {
  builtinGatewayWorkspacesMethodDescriptors,
} from './method-catalog-workspaces.js';
import {
  builtinGatewayStepUpMethodDescriptors,
} from './method-catalog-stepup.js';
import { GatewayVerbError } from './routes/gateway-verb-error.js';
import { SDKErrorCodes } from '@goodvibes-jev/engine/errors';

export type {
  GatewayEventDescriptor,
  GatewayEventListOptions,
  GatewayEventTransport,
  GatewayHttpBinding,
  GatewayMethodAccess,
  GatewayMethodDescriptor,
  GatewayMethodHandler,
  GatewayMethodInvocation,
  GatewayMethodInvocationContext,
  GatewayMethodListOptions,
  GatewayMethodSource,
  GatewayMethodTransport,
} from './method-catalog-shared.js';

interface RegisteredGatewayMethod {
  readonly descriptor: GatewayMethodDescriptor;
  readonly handler?: GatewayMethodHandler | undefined;
}

interface RegisteredGatewayEvent {
  readonly descriptor: GatewayEventDescriptor;
}

const BUILTIN_GATEWAY_EVENTS: readonly GatewayEventDescriptor[] = builtinGatewayEventDescriptors;

const BUILTIN_GATEWAY_METHODS: readonly GatewayMethodDescriptor[] = [
  ...builtinGatewayWorkLedgerMethodDescriptors,
  ...builtinGatewayNativeWorkExecutionMethodDescriptors,
  ...builtinGatewayNativeWorkSubmissionMethodDescriptors,
  ...builtinGatewayNativeConversationIntakeMethodDescriptors,
  ...builtinDelegatedInboundMethodDescriptors,
  ...builtinGatewayNativeHostedTurnMethodDescriptors,
  ...builtinGatewayControlMethodDescriptors,
  ...builtinBrowserJudgmentMethodDescriptors,
  ...builtinGatewayChannelMethodDescriptors,
  ...builtinGatewayChannelTestMethodDescriptors,
  ...builtinGatewayCostMethodDescriptors,
  ...builtinGatewayPermissionRuleMethodDescriptors,
  ...builtinGatewayEmailMethodDescriptors,
  ...builtinGatewayPaymentsMethodDescriptors,
  ...builtinGatewayCalendarMethodDescriptors,
  ...builtinGatewayBrowserMethodDescriptors,
  ...builtinGatewayRuntimeMethodDescriptors,
  ...builtinGatewayModelMethodDescriptors,
  ...builtinGatewayUpdateMethodDescriptors,
  ...builtinGatewayRelayMethodDescriptors,
  ...builtinGatewayKnowledgeMethodDescriptors,
  ...builtinGatewayMediaMethodDescriptors,
  ...builtinGatewayAdminMethodDescriptors,
  ...builtinGatewayPushMethodDescriptors,
  ...builtinGatewayPairingMethodDescriptors,
  ...builtinGatewayTailscaleMethodDescriptors,
  ...builtinGatewayAcpMethodDescriptors,
  ...builtinGatewaySkillsMethodDescriptors,
  ...builtinGatewayPrincipalsMethodDescriptors,
  ...builtinGatewayOwnerProfileMethodDescriptors,
  ...builtinGatewayOccasionsMethodDescriptors,
  ...builtinGatewayChannelProfilesMethodDescriptors,
  ...builtinGatewayCheckinMethodDescriptors,
  ...builtinGatewayCiMethodDescriptors,
  ...builtinGatewayFlagsMethodDescriptors,
  ...builtinGatewayRewindMethodDescriptors,
  ...builtinGatewayWorkspacesMethodDescriptors,
  ...builtinGatewayStepUpMethodDescriptors,
];

function normalizeDescriptor(descriptor: GatewayMethodDescriptor): GatewayMethodDescriptor {
  const id = descriptor.id.trim();
  if (!id) throw new Error('Gateway method id is required');
  return Object.freeze({
    ...descriptor,
    id,
    transport: Object.freeze([...new Set(descriptor.transport)]),
    scopes: Object.freeze([...new Set(descriptor.scopes)]),
    events: descriptor.events ? Object.freeze([...new Set(descriptor.events)]) : undefined,
    ...(descriptor.http ? { http: Object.freeze({ ...descriptor.http }) } : {}),
    invokable: descriptor.invokable ?? true,
  });
}

function normalizeEventDescriptor(descriptor: GatewayEventDescriptor): GatewayEventDescriptor {
  const id = descriptor.id.trim();
  if (!id) throw new Error('Gateway event id is required');
  return Object.freeze({
    ...descriptor,
    id,
    transport: Object.freeze([...new Set(descriptor.transport)]),
    scopes: Object.freeze([...new Set(descriptor.scopes)]),
    domains: descriptor.domains ? Object.freeze([...new Set(descriptor.domains)]) : undefined,
    wireEvents: descriptor.wireEvents ? Object.freeze([...new Set(descriptor.wireEvents)]) : undefined,
  });
}

/** The actual grant ceiling used by authenticated transport and native recovery. */
export function grantedGatewayScopes(catalog: Pick<GatewayMethodCatalog, 'getAllScopes'>, includeWrite: boolean): string[] {
  const scopes = new Set(catalog.getAllScopes({ includeWrite }));
  scopes.add('read:events'); scopes.add('read:control-plane'); scopes.add('read:telemetry');
  if (includeWrite) { scopes.add('read:telemetry-sensitive'); scopes.add('write:control-plane'); }
  return [...scopes].sort();
}

export interface GatewayScopePolicyOwner {
  /** Exact immutable registered scope state. Requires this still-attached owner. */
  current(): Readonly<{ revision: string; scopes: readonly string[] }>;
  close(): void;
}

function pathMatchesTemplate(template: string, pathname: string): boolean {
  const normalize = (value: string) => value.replace(/\/+$/, '') || '/';
  const templateParts = normalize(template).split('/');
  const pathParts = normalize(pathname).split('/');
  if (templateParts.length !== pathParts.length) return false;
  return templateParts.every((segment, index) => {
    if (segment.startsWith('{') && segment.endsWith('}')) return (pathParts[index]?.length ?? 0) > 0;
    return segment === pathParts[index];
  });
}

export class GatewayMethodCatalog {
  private readonly methods = new Map<string, RegisteredGatewayMethod>();
  private readonly events = new Map<string, RegisteredGatewayEvent>();
  private scopePolicyOwner: { readonly beforeMutation: () => void } | undefined;
  private scopePolicyChanging = false;
  private scopePolicyRetired = false;

  /**
   * Called after initial host construction. Startup registration is hydration,
   * while all subsequent mutations persist revocation before changing scopes.
   * The callback is an owner precondition, never an authority reconstructed from
   * a stored watch, grant identifier, or caller-supplied scope list.
   */
  attachScopePolicyOwner(beforeMutation: () => void): GatewayScopePolicyOwner {
    if (this.scopePolicyOwner || this.scopePolicyRetired) throw new Error('Gateway scope policy owner is already attached or retired');
    const owner = { beforeMutation }; this.scopePolicyOwner = owner;
    return Object.freeze({
      current: () => {
        if (this.scopePolicyOwner !== owner || this.scopePolicyChanging) throw new Error('Gateway scope policy owner is unavailable');
        const methods = [...this.methods].sort(([a], [b]) => a.localeCompare(b)).map(([id, entry]) => {
          const value = entry.descriptor;
          return [id, value.source, value.pluginId ?? null, value.access, [...value.transport].sort(), [...value.scopes].sort(),
            value.http ? [value.http.method, value.http.path] : null, value.invokable, value.dangerous ?? false, typeof entry.handler === 'function'];
        });
        const events = [...this.events].sort(([a], [b]) => a.localeCompare(b)).map(([id, entry]) => {
          const value = entry.descriptor;
          return [id, value.source, value.pluginId ?? null, [...value.transport].sort(), [...value.scopes].sort(),
            [...(value.domains ?? [])].sort(), [...(value.wireEvents ?? [])].sort()];
        });
        return Object.freeze({ revision: createHash('sha256').update(JSON.stringify({ methods, events })).digest('hex'),
          scopes: Object.freeze(grantedGatewayScopes(this, true)) });
      },
      close: () => {
        if (this.scopePolicyOwner !== owner) return;
        // Daemon retirement is not a policy withdrawal. Reconstructed startup
        // may recover unchanged durable grants. This instance cannot reattach
        // or mint durable custody after teardown starts.
        this.scopePolicyRetired = true; this.scopePolicyOwner = undefined;
      },
    });
  }

  private beforeScopeMutation(): void {
    const owner = this.scopePolicyOwner; if (!owner) return;
    if (this.scopePolicyChanging) throw new Error('Gateway scope policy mutation is reentrant');
    this.scopePolicyChanging = true;
    try {
      const result: unknown = owner.beforeMutation();
      if (result && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') throw new Error('Gateway scope policy mutation must be synchronous');
      if (this.scopePolicyOwner !== owner) throw new Error('Gateway scope policy owner changed');
    } finally { this.scopePolicyChanging = false; }
  }

  constructor(options: { readonly includeBuiltins?: boolean } = {}) {
    if (options.includeBuiltins !== false) {
      for (const descriptor of BUILTIN_GATEWAY_METHODS) {
        this.register(descriptor, undefined, { replace: true });
      }
      for (const descriptor of BUILTIN_GATEWAY_EVENTS) {
        this.registerEvent(descriptor, { replace: true });
      }
    }
  }

  register(
    descriptor: GatewayMethodDescriptor,
    handler?: GatewayMethodHandler,
    options: { readonly replace?: boolean } = {},
  ): () => void {
    const normalized = normalizeDescriptor(descriptor);
    if (this.methods.has(normalized.id) && !options.replace) {
      throw new Error(`Gateway method already registered: ${normalized.id}`);
    }
    const registered = { descriptor: normalized, handler };
    this.beforeScopeMutation();
    this.methods.set(normalized.id, registered);
    return () => {
      const current = this.methods.get(normalized.id);
      if (current === registered) {
        this.unregister(normalized.id);
      }
    };
  }

  registerEvent(
    descriptor: GatewayEventDescriptor,
    options: { readonly replace?: boolean } = {},
  ): () => void {
    const normalized = normalizeEventDescriptor(descriptor);
    if (this.events.has(normalized.id) && !options.replace) {
      throw new Error(`Gateway event already registered: ${normalized.id}`);
    }
    const registered = { descriptor: normalized };
    this.beforeScopeMutation();
    this.events.set(normalized.id, registered);
    return () => {
      const current = this.events.get(normalized.id);
      if (current === registered) {
        this.unregisterEvent(normalized.id);
      }
    };
  }

  unregister(id: string): boolean {
    if (!this.methods.has(id)) return false;
    this.beforeScopeMutation();
    return this.methods.delete(id);
  }

  unregisterEvent(id: string): boolean {
    if (!this.events.has(id)) return false;
    this.beforeScopeMutation();
    return this.events.delete(id);
  }

  clearPluginMethods(pluginId: string): void {
    if (![...this.methods.values(), ...this.events.values()].some(entry => entry.descriptor.pluginId === pluginId)) return;
    this.beforeScopeMutation();
    for (const [id, entry] of this.methods.entries()) {
      if (entry.descriptor.pluginId === pluginId) {
        this.methods.delete(id);
      }
    }
    for (const [id, entry] of this.events.entries()) {
      if (entry.descriptor.pluginId === pluginId) {
        this.events.delete(id);
      }
    }
  }

  list(options: GatewayMethodListOptions = {}): GatewayMethodDescriptor[] {
    return [...this.methods.values()]
      .map((entry) => entry.descriptor)
      .filter((descriptor) => !options.category || descriptor.category === options.category)
      .filter((descriptor) => !options.source || descriptor.source === options.source)
      .filter((descriptor) => !options.pluginId || descriptor.pluginId === options.pluginId)
      .sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
  }

  listEvents(options: GatewayEventListOptions = {}): GatewayEventDescriptor[] {
    return [...this.events.values()]
      .map((entry) => entry.descriptor)
      .filter((descriptor) => !options.category || descriptor.category === options.category)
      .filter((descriptor) => !options.source || descriptor.source === options.source)
      .filter((descriptor) => !options.pluginId || descriptor.pluginId === options.pluginId)
      .filter((descriptor) => !options.domain || descriptor.domains?.includes(options.domain))
      .sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
  }

  get(id: string): GatewayMethodDescriptor | null {
    return this.methods.get(id)?.descriptor ?? null;
  }

  getEvent(id: string): GatewayEventDescriptor | null {
    return this.events.get(id)?.descriptor ?? null;
  }

  hasHandler(id: string): boolean {
    return typeof this.methods.get(id)?.handler === 'function';
  }

  findByHttpBinding(method: string, pathname: string): GatewayMethodDescriptor | null {
    const normalizedMethod = method.toUpperCase();
    for (const entry of this.methods.values()) {
      const binding = entry.descriptor.http;
      if (!binding || binding.method !== normalizedMethod) continue;
      if (pathMatchesTemplate(binding.path, pathname)) return entry.descriptor;
    }
    return null;
  }

  getAllScopes(options: { readonly includeWrite?: boolean } = {}): string[] {
    const scopes = new Set<string>();
    for (const descriptor of this.methods.values()) {
      for (const scope of descriptor.descriptor.scopes) {
        if (!options.includeWrite && !scope.startsWith('read:')) continue;
        scopes.add(scope);
      }
    }
    for (const descriptor of this.events.values()) {
      for (const scope of descriptor.descriptor.scopes) {
        if (!options.includeWrite && !scope.startsWith('read:')) continue;
        scopes.add(scope);
      }
    }
    return [...scopes].sort();
  }

  /**
   * Run a method's registered internal handler directly. Note this does NOT consult
   * `descriptor.invokable` for a method that HAS a handler, see the field's doc
   * comment in method-catalog-shared.ts: a runtime that registered a real handler is
   * authoritative over whether the method works, the descriptor's `invokable` flag
   * is not. `invokeGatewayMethodCall` (../daemon/control-plane.ts) is what enforces
   * `invokable` for the generic HTTP/WS dispatch surface, via
   * `validateGatewayInvocation`, BEFORE ever reaching here.
   */
  async invoke(id: string, invocation: GatewayMethodInvocation): Promise<unknown> {
    const entry = this.methods.get(id);
    // Uncataloged id, a real machine code (METHOD_NOT_FOUND), not a prose Error, so
    // any direct caller of invoke() (bypassing the HTTP dispatch's own 404 below) gets
    // the same code-driven signal as invokeGatewayMethod/getGatewayMethod
    // (daemon-sdk/control-routes.ts) and invokeGatewayMethodCall (../daemon/control-
    // plane.ts), distinct from NOT_INVOKABLE (cataloged but not invokable), which is
    // the id existing but refusing dispatch, not the id being unknown outright.
    if (!entry) {
      throw new GatewayVerbError(`Unknown gateway method: ${id}`, SDKErrorCodes.METHOD_NOT_FOUND, 404);
    }
    if (!entry.handler) {
      // A method explicitly marked invokable:false with no registered handler is
      // honestly "not invokable anywhere" (see the field's doc comment), distinct
      // from a method that a caller expected to have a handler here but doesn't (a
      // real bug in that caller's wiring). A GatewayVerbError flows straight through
      // invokeGatewayMethodCall's existing catch into an honest 400/NOT_INVOKABLE
      // instead of a generic 500, and gives any OTHER caller of `invoke()` directly
      // (bypassing the HTTP gate) the same honest, typed signal.
      if (entry.descriptor.invokable === false) {
        throw new GatewayVerbError(
          `Gateway method is not invokable and has no registered handler: ${id}`,
          'NOT_INVOKABLE',
          400,
        );
      }
      throw new Error(`Gateway method has no internal handler: ${id}`);
    }
    return entry.handler(invocation);
  }
}
import { createHash } from 'node:crypto';
