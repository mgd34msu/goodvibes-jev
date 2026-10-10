import { snapshotJudgmentInput } from '@goodvibes-jev/engine/sdk/platform/gate';
import { getOperatorContract } from '@goodvibes-jev/engine/sdk/contracts';
import { previewHarnessText } from './agent-harness-text.ts';
import { rankHarnessCatalog, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { CATALOG_QUERIES } from './agent-harness-catalog-filters.ts';
import { catalogEnvelope, catalogFilters } from './agent-harness-tool-utils.ts';

export interface AgentHarnessOperatorMethodArgs {
  readonly methodId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

type OperatorMethodEffect =
  | 'read-only-network'
  | 'confirmed-connected-host-state'
  | 'confirmed-admin-connected-host-state';

type OperatorMethodLookupSource = 'methodId' | 'target' | 'query';

interface OperatorContractMethod {
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly category?: string;
  readonly access?: string;
  readonly scopes?: readonly string[];
  readonly http?: {
    readonly method?: string;
    readonly path?: string;
  };
  readonly inputSchema?: Record<string, unknown>;
  readonly invokable?: boolean;
}

interface OperatorMethodDescriptor {
  readonly id: string;
  readonly label: string;
  /**
   * The contract's own title and description, kept SEPARATELY from `label`.
   *
   * `label` collapses the two (`title ?? description ?? id`) and is replaced
   * outright for an unavailable method, so a search over `label` alone reads
   * whichever one of them happened to win and never the other. Both are held
   * here so {@link methodSearchText} can index both, the description is where
   * a method says what it is FOR, and it was the field the catalog search
   * could not see.
   */
  readonly title: string;
  readonly description: string;
  readonly route: string;
  readonly effect: OperatorMethodEffect;
  readonly owner: 'goodvibes-daemon';
  readonly preferredModelTool: string;
  readonly confirmation: string;
  readonly boundary: string;
  readonly category: string;
  readonly access: string;
  readonly scopes: readonly string[];
  readonly available: boolean;
  readonly parameters?: readonly Record<string, unknown>[];
  /** Full schema is protected evidence; display still uses its bounded projection. */
  readonly inputSchema?: Record<string, unknown>;
}

/**
 * Capability-advertisement honesty: the SDK operator contract marks
 * a method `invokable: false` when it is cataloged but not backed by a real
 * daemon route (see @goodvibes-jev/engine/sdk's method-catalog-route-reconcile,
 * email.inbox.list/read, email.draft.create, email.send are the dogfood
 * case: they advertise /api/email/* paths no router dispatch chain serves).
 * Before this, `invokable` was declared on the local contract-method shape
 * but never read, an unavailable method looked identical to a live one in
 * this catalog, so the model (or a human skimming host action:"methods")
 * had no way to tell the ad from the reality short of trying the call and
 * getting a 404. Degrading the listing here means the ad itself, not just
 * the eventual answer, tells the truth.
 */
function methodIsAvailable(method: OperatorContractMethod): boolean {
  return method.invokable !== false;
}

const UNAVAILABLE_MODEL_TOOL = 'none, unavailable; do not call this method';
const UNAVAILABLE_CONFIRMATION = 'Unavailable: cataloged by the daemon but not backed by a served route. Do not call it; it will not succeed.';
const UNAVAILABLE_BOUNDARY = 'This method is advertised in the operator contract but the daemon does not currently serve its route (invokable:false). Treat it as absent, do not attempt to call it, and tell the user the capability is not wired up rather than guessing at a workaround.';

function unavailableLabel(method: OperatorContractMethod): string {
  return `${method.id}, unavailable (route not served by this daemon)`;
}

type OperatorMethodResolution =
  | { readonly status: 'found'; readonly method: Record<string, unknown> }
  | {
      readonly status: 'ambiguous';
      readonly input: string;
      readonly candidates: readonly Record<string, unknown>[];
    }
  | { readonly status: 'missing_lookup'; readonly usage: string };

const READ_ONLY_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(500, Math.trunc(parsed)));
}

function operatorContractMethods(): readonly OperatorContractMethod[] {
  const contract = getOperatorContract();
  const methods = Array.isArray(contract.operator?.methods)
    ? contract.operator.methods as OperatorContractMethod[]
    : [];
  return methods
    .filter((method) => method.id && method.http?.method && method.http.path)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function methodIsReadOnly(method: OperatorContractMethod): boolean {
  const httpMethod = method.http?.method?.toUpperCase();
  if (httpMethod && READ_ONLY_HTTP_METHODS.has(httpMethod)) return true;
  const scopes = method.scopes ?? [];
  return scopes.length > 0 && scopes.every((scope) => scope.startsWith('read:'));
}

function methodEffect(method: OperatorContractMethod): OperatorMethodEffect {
  if (methodIsReadOnly(method)) return 'read-only-network';
  return method.access === 'admin'
    ? 'confirmed-admin-connected-host-state'
    : 'confirmed-connected-host-state';
}

function confirmationFor(effect: OperatorMethodEffect): string {
  if (effect === 'read-only-network') return 'Read-only; confirmation is not required.';
  if (effect === 'confirmed-admin-connected-host-state') {
    return 'Admin route. Requires confirm:true and explicitUserRequest naming the requested change.';
  }
  return 'Mutation route. Requires confirm:true and explicitUserRequest naming the requested change.';
}

function preferredToolFor(effect: OperatorMethodEffect): string {
  if (effect === 'read-only-network') return 'agent_operator_method';
  return 'agent_operator_method with confirm:true and explicitUserRequest';
}

function parametersFromInputSchema(method: OperatorContractMethod): readonly Record<string, unknown>[] {
  const schema = snapshotJudgmentInput(method.inputSchema) as Record<string, unknown> | undefined;
  const properties = schema?.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return [];
  const required = Array.isArray(schema.required)
    ? new Set(schema.required.filter((entry): entry is string => typeof entry === 'string'))
    : new Set<string>();
  return Object.entries(properties as Record<string, Record<string, unknown>>)
    .slice(0, 48)
    .map(([name, property]) => ({
      name,
      required: required.has(name),
      type: typeof property?.type === 'string' ? property.type : undefined,
      enum: Array.isArray(property?.enum) ? property.enum : undefined,
    }));
}

function toDescriptor(method: OperatorContractMethod): OperatorMethodDescriptor {
  const httpMethod = method.http?.method?.toUpperCase() ?? 'GET';
  const path = method.http?.path ?? '/';
  const effect = methodEffect(method);
  const available = methodIsAvailable(method);
  const label = available ? (method.title ?? method.description ?? method.id) : unavailableLabel(method);
  return {
    id: method.id,
    label,
    title: method.title ?? '',
    description: method.description ?? '',
    route: `${httpMethod} ${path}`,
    effect,
    owner: 'goodvibes-daemon',
    preferredModelTool: available ? preferredToolFor(effect) : UNAVAILABLE_MODEL_TOOL,
    confirmation: available ? confirmationFor(effect) : UNAVAILABLE_CONFIRMATION,
    boundary: available
      ? (effect === 'read-only-network'
        ? 'Reads the connected GoodVibes daemon operator route and returns a redacted response.'
        : 'Runs a confirmed connected GoodVibes daemon operator route. The model must keep the action visible, reversible when possible, and tied to the user request.')
      : UNAVAILABLE_BOUNDARY,
    category: method.category ?? 'uncategorized',
    access: method.access ?? 'authenticated',
    scopes: method.scopes ?? [],
    available,
    parameters: available ? parametersFromInputSchema(method) : [],
    ...(method.inputSchema ? { inputSchema: method.inputSchema } : {}),
  };
}

function allOperatorMethods(): readonly OperatorMethodDescriptor[] {
  return operatorContractMethods().map(toDescriptor);
}

/** Contract-owned semantic evidence; category aliases no longer decide relevance. */
function methodSearchText(method: OperatorMethodDescriptor): string {
  return [
    method.id,
    method.label,
    method.title,
    method.description,
    method.category,
    method.route,
    method.effect,
    method.access,
    method.scopes.join(' '),
  ].join('\n');
}

function describeMethod(
  method: OperatorMethodDescriptor,
  options: { readonly includeParameters?: boolean; readonly lookup?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return {
    id: method.id,
    label: method.label,
    category: method.category,
    access: method.access,
    effect: method.effect,
    owner: method.owner,
    route: method.route,
    available: method.available,
    modelRoute: previewHarnessText(method.preferredModelTool),
    scopes: method.scopes,
    confirmation: method.confirmation,
    ...(options.lookup ? { lookup: options.lookup } : {}),
    ...(options.includeParameters ? {
      preferredModelTool: method.preferredModelTool,
      boundary: method.boundary,
      parameters: method.parameters ?? [],
    } : {
      summary: previewHarnessText(method.boundary),
    }),
  };
}

function describeCandidate(method: OperatorMethodDescriptor): Record<string, unknown> {
  return {
    methodId: method.id,
    category: method.category,
    effect: method.effect,
    route: method.route,
    available: method.available,
    modelRoute: previewHarnessText(method.preferredModelTool),
  };
}

function lookupFromArgs(args: AgentHarnessOperatorMethodArgs): { readonly source: OperatorMethodLookupSource; readonly input: string } | null {
  const methodId = readString(args.methodId);
  if (methodId) return { source: 'methodId', input: methodId };
  const target = readString(args.target);
  if (target) return { source: 'target', input: target };
  const query = readString(args.query);
  return query ? { source: 'query', input: query } : null;
}

export function operatorMethodCatalogStatus(): Record<string, unknown> {
  const methods = allOperatorMethods();
  const categories = methods.reduce<Record<string, number>>((acc, method) => {
    acc[method.category] = (acc[method.category] ?? 0) + 1;
    return acc;
  }, {});
  const unavailableMethods = methods.filter((method) => !method.available).length;
  return {
    modes: ['operator_methods', 'operator_method'],
    methods: methods.length,
    readOnlyMethods: methods.filter((method) => method.effect === 'read-only-network').length,
    confirmedMethods: methods.filter((method) => method.effect !== 'read-only-network').length,
    adminMethods: methods.filter((method) => method.effect === 'confirmed-admin-connected-host-state').length,
    unavailableMethods,
    categories,
    policy: unavailableMethods > 0
      ? `Full GoodVibes SDK operator contract. Read-only routes can run through agent_operator_method; write/admin routes require confirm:true and explicitUserRequest. ${unavailableMethods} cataloged method(s) are currently unavailable (no served route), check each method's "available" field before treating it as callable.`
      : 'Full GoodVibes SDK operator contract. Read-only routes can run through agent_operator_method; write/admin routes require confirm:true and explicitUserRequest.',
  };
}

/** Semantic discovery delegates the complete catalog to the canonical reader. */
export async function operatorMethodSummary(args: AgentHarnessOperatorMethodArgs, options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const query = readString(args.query);
  const limit = readLimit(args.limit, 200);
  const includeParameters = args.includeParameters === true;
  const all = allOperatorMethods();
  const found = query ? await rankHarnessCatalog(all, query, (entry) => ({ id: entry.id, description: methodSearchText(entry), evidence: entry }), 'agent.harness.operator-methods', { ...options, requirePreservedSource: true })
    : { matches: all.map((entry) => ({ entry, judgment: undefined })) };
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const methods = found.matches
    .slice(0, limit)
    .map(({ entry, judgment }) => ({ ...describeMethod(entry, { includeParameters }), ...(judgment ? { judgment } : {}) }));
  return {
    ...catalogEnvelope(
      'methods',
      methods,
      all.length,
      catalogFilters(args, CATALOG_QUERIES.methods.filters),
      CATALOG_QUERIES.methods.discovery,
      { relaxedQuery: false },
    ),
    policy: 'Dynamic GoodVibes daemon operator catalog. Prefer simpler first-class tools when available; use agent_operator_method for exact contract parity.',
  };
}

export async function describeHarnessOperatorMethod(args: AgentHarnessOperatorMethodArgs, options: CatalogRankingOptions = {}): Promise<OperatorMethodResolution> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const lookup = lookupFromArgs(args);
  if (!lookup) {
    return {
      status: 'missing_lookup',
      usage: 'operator_method requires methodId, target, or query.',
    };
  }
  const methods = allOperatorMethods();
  const normalized = lookup.input.toLowerCase();
  const exact = methods.find((method) => method.id === lookup.input);
  if (exact) {
    return { status: 'found', method: describeMethod(exact, { includeParameters: true, lookup: { ...lookup, resolvedBy: 'id' } }) };
  }
  const insensitive = methods.find((method) => method.id.toLowerCase() === normalized);
  if (insensitive) {
    return { status: 'found', method: describeMethod(insensitive, { includeParameters: true, lookup: { ...lookup, resolvedBy: 'case-insensitive-id' } }) };
  }
  if (lookup.source === 'methodId') return { status: 'missing_lookup', usage: `Unknown operator method ${lookup.input}. Use host action:"methods" to inspect available methods.` };
  const found = await rankHarnessCatalog(methods, lookup.input, (entry) => ({ id: entry.id, description: methodSearchText(entry), evidence: entry }), 'agent.harness.operator-methods', { ...options, requirePreservedSource: true });
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const searched = found.matches;
  if (searched.length === 1 && searched[0]!.judgment.reading.verdict === 'yes') {
    return { status: 'found', method: { ...describeMethod(searched[0]!.entry, {
      includeParameters: true, lookup: { ...lookup, resolvedBy: 'search' },
    }), judgment: searched[0]!.judgment } };
  }
  if (searched.length > 0) {
    return { status: 'ambiguous', input: lookup.input,
      candidates: searched.slice(0, 8).map(({ entry, judgment }) => ({ ...describeCandidate(entry), judgment })),
    };
  }
  return {
    status: 'missing_lookup',
    usage: `Unknown operator method ${lookup.input}. Nothing in the ${methods.length} cataloged methods was selected by the catalog reading. Use host action:"methods" with no query to list them all.`,
  };
}
