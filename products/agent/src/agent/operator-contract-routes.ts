/**
 * operator-contract-routes.ts, one place that turns an operator method id into
 * the HTTP request that reaches the daemon.
 *
 * The daemon's operator contract already carries, per method, the verb and the
 * path template it is served on (`method.http.method` / `method.http.path`).
 * Anything in this product that needs to CALL a method reads it from there.
 *
 * Why this module exists rather than a table per caller: a hand-written table
 * is a copy of the contract that nothing re-checks. The path moves in the
 * daemon, the contract moves with it, and the copy keeps pointing at a route
 * that now 404s, which reads to an operator as a broken feature rather than as
 * a stale binding. Deriving means the two cannot disagree, and the drift test
 * beside this module pins the ids so a method that DISAPPEARS from the contract
 * fails loudly instead of resolving to nothing at runtime.
 *
 * `substituteOperatorPath` consumes the parameters it fills, so what remains in
 * the payload is exactly the body (or the query string, for a read), the same
 * split every caller needs and none of them should re-derive.
 */

import { getOperatorContract } from '@goodvibes-jev/engine/sdk/contracts';

export type JsonRecord = Record<string, unknown>;

/** The subset of a contract method entry this module reads. */
export interface OperatorContractMethodEntry {
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

/** A method's HTTP binding, exactly as the contract states it. */
export interface OperatorHttpBinding {
  readonly methodId: string;
  /** Upper-cased verb: GET, POST, DELETE, … */
  readonly httpMethod: string;
  /** Path template with `{name}` placeholders, un-substituted. */
  readonly pathTemplate: string;
}

/** A request prepared for the wire: verb, substituted path, remaining payload. */
export interface PreparedOperatorRequest {
  readonly methodId: string;
  readonly httpMethod: string;
  /** Path with every `{name}` filled in and URL-encoded. */
  readonly path: string;
  /** What was left after the path parameters were consumed. */
  readonly payload: JsonRecord;
}

export const READ_ONLY_HTTP_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

let methodIndex: Map<string, OperatorContractMethodEntry> | null = null;

function buildMethodIndex(): Map<string, OperatorContractMethodEntry> {
  const contract = getOperatorContract();
  const methods = Array.isArray(contract.operator?.methods)
    ? (contract.operator.methods as OperatorContractMethodEntry[])
    : [];
  const index = new Map<string, OperatorContractMethodEntry>();
  for (const method of methods) {
    if (typeof method?.id === 'string' && method.id) index.set(method.id, method);
  }
  return index;
}

function operatorMethodIndex(): Map<string, OperatorContractMethodEntry> {
  methodIndex ??= buildMethodIndex();
  return methodIndex;
}

/**
 * Drop the memoized contract index.
 *
 * The contract is a build artifact and does not change while the process runs,
 * so the index is built once. Tests that swap contracts call this.
 */
export function resetOperatorContractCache(): void {
  methodIndex = null;
}

/** Every method the contract publishes, by id. Read-only view. */
export function operatorContractMethods(): readonly OperatorContractMethodEntry[] {
  return [...operatorMethodIndex().values()];
}

/** The contract entry for a method id, or null when the contract has no such id. */
export function findOperatorContractMethod(methodId: string): OperatorContractMethodEntry | null {
  return operatorMethodIndex().get(methodId) ?? null;
}

/** A method's HTTP binding, or null when the id is unknown or has no HTTP route. */
export function findOperatorHttpBinding(methodId: string): OperatorHttpBinding | null {
  const method = findOperatorContractMethod(methodId);
  const httpMethod = method?.http?.method?.toUpperCase();
  const pathTemplate = method?.http?.path;
  if (!httpMethod || !pathTemplate) return null;
  return { methodId, httpMethod, pathTemplate };
}

/**
 * A method's HTTP binding, or a thrown error naming the id.
 *
 * Used where the id is a compile-time constant of this product: reaching the
 * throw means the contract this build was compiled against no longer serves a
 * method this build calls, which is a build-time mistake wearing a runtime
 * costume and should be loud.
 */
export function requireOperatorHttpBinding(methodId: string): OperatorHttpBinding {
  const binding = findOperatorHttpBinding(methodId);
  if (!binding) {
    throw new Error(`operator method '${methodId}' has no HTTP binding in the operator contract.`);
  }
  return binding;
}

function encodePathValue(value: unknown, name: string): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return encodeURIComponent(String(value));
  }
  throw new Error(`operator method path parameter '${name}' must be a string, number, or boolean.`);
}

/**
 * Fill a path template from a payload, REMOVING each parameter it consumes.
 *
 * Mutates `payload` deliberately: what is left over is the body (or the query
 * string), and a path parameter echoed into the body as well is how a daemon
 * ends up rejecting a request for an unexpected property.
 */
export function substituteOperatorPath(pathTemplate: string, payload: JsonRecord): string {
  let path = pathTemplate.replace(/\{([^}]+)\}/g, (_match, rawName: string) => {
    const name = rawName.trim();
    if (!(name in payload)) throw new Error(`operator method path parameter '${name}' is required.`);
    const encoded = encodePathValue(payload[name], name);
    delete payload[name];
    return encoded;
  });
  path = path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (match, name: string) => {
    if (!(name in payload)) return match;
    const encoded = encodePathValue(payload[name], name);
    delete payload[name];
    return encoded;
  });
  return path;
}

/** Append the leftover payload as a query string. For read verbs. */
export function appendOperatorQuery(path: string, payload: JsonRecord): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      query.set(key, String(value));
    } else {
      query.set(key, JSON.stringify(value));
    }
  }
  const queryString = query.toString();
  if (!queryString) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${queryString}`;
}

/**
 * Prepare a request for a method id and an input object.
 *
 * The input is copied before path substitution, so a caller's object is never
 * mutated by having its ids removed.
 */
export function prepareOperatorRequest(methodId: string, input: unknown): PreparedOperatorRequest {
  const binding = requireOperatorHttpBinding(methodId);
  const payload: JsonRecord = input && typeof input === 'object' && !Array.isArray(input)
    ? { ...(input as JsonRecord) }
    : {};
  const path = substituteOperatorPath(binding.pathTemplate, payload);
  return { methodId, httpMethod: binding.httpMethod, path, payload };
}

/** True when the method's verb reads rather than writes. */
export function operatorMethodIsReadOnly(methodId: string): boolean {
  const binding = findOperatorHttpBinding(methodId);
  if (!binding) return false;
  return READ_ONLY_HTTP_METHODS.has(binding.httpMethod);
}

/**
 * The full request path for a prepared request, query string included for a
 * read verb, untouched for a write.
 */
export function operatorRequestPath(request: PreparedOperatorRequest): string {
  return READ_ONLY_HTTP_METHODS.has(request.httpMethod)
    ? appendOperatorQuery(request.path, request.payload)
    : request.path;
}
