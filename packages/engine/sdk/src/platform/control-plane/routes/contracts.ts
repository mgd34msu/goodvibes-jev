/**
 * routes/contracts.ts, the handlers behind `contracts.*`
 * (docs/design/contract-runner.md 10.2).
 *
 * Thin on purpose: reading the arguments and mapping refusals. What a
 * contract is, and which runner holds it, lives in
 * contract/operator-service.ts, so the methods, their REST paths and the
 * external work adapters cannot drift into different ideas of start, cancel
 * and reply.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
import { ContractOperatorError, projectContractOperatorView, type ContractOperatorService } from '../../contract/operator-service.js';

/** The reason a cancel over the operator surface records when the caller gives none. */
export const OPERATOR_CANCEL_REASON = 'cancelled by an operator';

function requireString(params: Record<string, unknown>, field: string): string {
  const value = params[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GatewayVerbError(`${field} is required`, 'INVALID_ARGUMENT', 400, field);
  }
  return value.trim();
}

function optionalString(params: Record<string, unknown>, field: string): string | undefined {
  const value = params[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new GatewayVerbError(`Invalid ${field}: expected a string`, 'INVALID_ARGUMENT', 400, field);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** A REST query carries booleans as text; the invoke body carries them as booleans. */
function optionalBoolean(params: Record<string, unknown>, field: string): boolean | undefined {
  const value = params[field];
  if (value === undefined || value === null) return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new GatewayVerbError(`Invalid ${field}: expected true or false`, 'INVALID_ARGUMENT', 400, field);
}

function optionalIsolation(params: Record<string, unknown>): 'auto' | 'worktree' | 'shared' | undefined {
  const value = params['isolation'];
  if (value === undefined || value === null) return undefined;
  if (value === 'auto' || value === 'worktree' || value === 'shared') return value;
  throw new GatewayVerbError('Invalid isolation: expected auto, worktree or shared', 'INVALID_ARGUMENT', 400, 'isolation');
}

/** Map the service's refusals onto the wire shape a client can act on. */
function toGatewayVerbError(error: unknown): never {
  if (error instanceof ContractOperatorError) {
    throw new GatewayVerbError(error.message, error.code, error.status, error.field);
  }
  throw error;
}

export function createContractsListHandler(service: ContractOperatorService): GatewayMethodHandler {
  return (invocation) => {
    const params = readInvocationParams(invocation);
    const sessionId = optionalString(params, 'sessionId');
    const includeTerminal = optionalBoolean(params, 'includeTerminal');
    return {
      contracts: service.list({
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(includeTerminal === undefined ? {} : { includeTerminal }),
      }).map(projectContractOperatorView),
    };
  };
}

export function createContractsGetHandler(service: ContractOperatorService): GatewayMethodHandler {
  return (invocation) => {
    const contractId = requireString(readInvocationParams(invocation), 'contractId');
    const contract = service.get(contractId);
    if (contract === null) throw new GatewayVerbError(`No contract ${contractId} on this daemon.`, 'CONTRACT_NOT_FOUND', 404);
    return projectContractOperatorView(contract);
  };
}

export function createContractsStartHandler(service: ContractOperatorService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    requireString(params, 'ask');
    // The ask is the person's words verbatim, the authority every stated criterion traces to: passed as given.
    const ask = params['ask'] as string;
    const sessionId = optionalString(params, 'sessionId');
    const workspaceRoot = optionalString(params, 'workspaceRoot');
    const isolation = optionalIsolation(params);
    try {
      return await service.start({
        ask,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
        ...(isolation === undefined ? {} : { isolation }),
      });
    } catch (error) {
      return toGatewayVerbError(error);
    }
  };
}

export function createContractsCancelHandler(service: ContractOperatorService): GatewayMethodHandler {
  return (invocation) => {
    const params = readInvocationParams(invocation);
    const contractId = requireString(params, 'contractId');
    const reason = optionalString(params, 'reason') ?? OPERATOR_CANCEL_REASON;
    try {
      return { cancelled: service.cancel(contractId, reason) };
    } catch (error) {
      return toGatewayVerbError(error);
    }
  };
}

export function createContractsReplyHandler(service: ContractOperatorService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const contractId = requireString(params, 'contractId');
    const escalationId = requireString(params, 'escalationId');
    const text = requireString(params, 'text');
    try {
      return await service.reply(contractId, escalationId, text);
    } catch (error) {
      return toGatewayVerbError(error);
    }
  };
}

/** Every method this module owns. */
export const CONTRACT_METHOD_IDS: readonly string[] = [
  'contracts.list',
  'contracts.get',
  'contracts.start',
  'contracts.cancel',
  'contracts.reply',
];

/**
 * Attach the handlers to their descriptors. Called once with the daemon's own
 * runner when the runtime services are built, and again with the hosted
 * runners joined in when the daemon hosts sessions; the later call replaces
 * the earlier handlers. A missing descriptor is a silent no-op, as for every
 * other route group.
 */
export function registerContractGatewayMethods(catalog: GatewayMethodCatalog, service: ContractOperatorService): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => {
    const descriptor = catalog.get(id);
    if (descriptor) catalog.register(descriptor, handler, { replace: true });
  };
  attach('contracts.list', createContractsListHandler(service));
  attach('contracts.get', createContractsGetHandler(service));
  attach('contracts.start', createContractsStartHandler(service));
  attach('contracts.cancel', createContractsCancelHandler(service));
  attach('contracts.reply', createContractsReplyHandler(service));
}
