/**
 * The contracts operator surface (docs/design/contract-runner.md 10.2): the
 * `contracts.*` methods, their REST bindings and the external work adapters
 * all act through this one service.
 *
 * A daemon process holds more than one runner: its own, composed with its
 * services, and one per hosted-session workspace floor (a floor's runner is
 * the one its sessions' turns, agent tool and intake use, so a contract a
 * hosted session starts lives there). The service reads across all of them:
 * `list` joins them, `get`, `cancel` and `reply` go to the runner that holds
 * the contract, and `start` goes to the hosted session's floor when the
 * session id names a live hosted session, else to the daemon's own runner.
 *
 * Every choice here is code over ids and recorded statuses; nothing is judged.
 */
import { isAbsolute } from 'node:path';
import type { OwnerReplyOutcome } from './escalation.js';
import type { ContractRunner } from './runner.js';
import { isTerminalContractStatus, type ContractOrigin, type ContractView } from './types.js';

/** The session a contract started over the operator surface without a session belongs to. */
export const OPERATOR_SESSION_ID = 'operator';

/** The runner surface the service reads and acts through. */
export type OperatorContractRunner = Pick<ContractRunner, 'start' | 'get' | 'list' | 'cancel' | 'reply'>;

/** A live hosted session's floor runner and the workspace its turns work in. */
export interface HostedSessionContracts {
  readonly runner: OperatorContractRunner;
  readonly workspaceRoot: string;
}

/** The hosted-session side, supplied by the hosted-session engine when the daemon hosts sessions. */
export interface HostedContractRunners {
  /** The runners of every composed workspace floor. */
  runners(): readonly OperatorContractRunner[];
  /**
   * The floor runner of a live hosted session, composing its loop first when
   * it was restored from disk; null when the id names no live hosted session.
   */
  forSession(sessionId: string): Promise<HostedSessionContracts | null>;
}

export interface OperatorStartInput {
  /** The person's words, verbatim. */
  readonly ask: string;
  readonly sessionId?: string | undefined;
  /** Absolute. For a hosted session it must be the session's own workspace when given. */
  readonly workspaceRoot?: string | undefined;
  readonly isolation?: 'auto' | 'worktree' | 'shared' | undefined;
}

export interface OperatorStartedContract {
  readonly contract: ContractView;
  readonly ownerAgentId: string;
}

export interface ContractOperatorService {
  list(filter?: { readonly sessionId?: string | undefined; readonly includeTerminal?: boolean | undefined }): ContractView[];
  get(contractId: string): ContractView | null;
  start(input: OperatorStartInput): Promise<OperatorStartedContract>;
  /** False when the contract is known but already ended. */
  cancel(contractId: string, reason: string): boolean;
  reply(contractId: string, escalationId: string, text: string): Promise<OwnerReplyOutcome>;
  /**
   * Joins the hosted-session runners in, or takes them out with null. The
   * hosted-session engine is composed after the runtime services that build
   * this service, so it attaches itself when it exists.
   */
  attachHosted(hosted: HostedContractRunners | null): void;
}

export type ContractOperatorErrorCode = 'CONTRACT_NOT_FOUND' | 'CONTRACT_ENDED' | 'INVALID_ARGUMENT';

/** A refusal with the wire code and status the operator routes report it under. */
export class ContractOperatorError extends Error {
  constructor(
    message: string,
    readonly code: ContractOperatorErrorCode,
    readonly status: 400 | 404 | 409,
    readonly field?: string | undefined,
  ) {
    super(message);
    this.name = 'ContractOperatorError';
  }
}

export interface ContractOperatorServiceDeps {
  /** The daemon's own runner. */
  readonly runner: OperatorContractRunner;
  /** Where a contract started without a workspace or a hosted session works. */
  readonly workingDirectory: string;
}

export function createContractOperatorService(deps: ContractOperatorServiceDeps): ContractOperatorService {
  /** Present while this daemon hosts sessions. */
  let hostedRunners: HostedContractRunners | null = null;
  const runners = (): readonly OperatorContractRunner[] => [deps.runner, ...(hostedRunners?.runners() ?? [])];

  /** The runner holding a contract, with its view; first found wins. */
  function holder(contractId: string): { readonly runner: OperatorContractRunner; readonly contract: ContractView } {
    for (const runner of runners()) {
      const contract = runner.get(contractId);
      if (contract !== null) return { runner, contract };
    }
    throw new ContractOperatorError(`No contract ${contractId} on this daemon.`, 'CONTRACT_NOT_FOUND', 404);
  }

  async function start(input: OperatorStartInput): Promise<OperatorStartedContract> {
    const ask = input.ask;
    if (ask.trim().length === 0) throw new ContractOperatorError('ask is required', 'INVALID_ARGUMENT', 400, 'ask');
    if (input.workspaceRoot !== undefined && !isAbsolute(input.workspaceRoot)) {
      throw new ContractOperatorError(
        `workspaceRoot must be an absolute path; '${input.workspaceRoot}' is not.`,
        'INVALID_ARGUMENT',
        400,
        'workspaceRoot',
      );
    }
    const hosted = input.sessionId === undefined || hostedRunners === null ? null : await hostedRunners.forSession(input.sessionId);
    if (hosted !== null && input.workspaceRoot !== undefined && input.workspaceRoot !== hosted.workspaceRoot) {
      throw new ContractOperatorError(
        `Hosted session ${input.sessionId} works in ${hosted.workspaceRoot}, not ${input.workspaceRoot}.`,
        'INVALID_ARGUMENT',
        400,
        'workspaceRoot',
      );
    }
    const origin: ContractOrigin = hosted === null ? 'external' : 'hosted';
    const started = (hosted?.runner ?? deps.runner).start({
      ask,
      sessionId: input.sessionId ?? OPERATOR_SESSION_ID,
      origin,
      projectRoot: hosted?.workspaceRoot ?? input.workspaceRoot ?? deps.workingDirectory,
      ...(input.isolation === undefined ? {} : { isolation: input.isolation }),
    });
    return { contract: started.contract, ownerAgentId: started.owner.id };
  }

  return {
    list(filter = {}) {
      const seen = new Set<string>();
      const contracts: ContractView[] = [];
      for (const runner of runners()) {
        for (const contract of runner.list(filter)) {
          if (seen.has(contract.id)) continue;
          seen.add(contract.id);
          contracts.push(contract);
        }
      }
      return contracts.sort((a, b) => b.createdAt - a.createdAt);
    },
    get(contractId) {
      for (const runner of runners()) {
        const contract = runner.get(contractId);
        if (contract !== null) return contract;
      }
      return null;
    },
    start,
    cancel(contractId, reason) {
      const { runner } = holder(contractId);
      return runner.cancel(contractId, reason);
    },
    async reply(contractId, escalationId, text) {
      const { runner, contract } = holder(contractId);
      if (isTerminalContractStatus(contract.status)) {
        throw new ContractOperatorError(`Contract ${contractId} has ended (${contract.status}); there is nothing to reply to.`, 'CONTRACT_ENDED', 409);
      }
      return runner.reply(contractId, escalationId, text);
    },
    attachHosted(hosted) {
      hostedRunners = hosted;
    },
  };
}
