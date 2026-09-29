/**
 * method-catalog-contracts.ts, the `contracts.*` operator methods
 * (docs/design/contract-runner.md 10.2): list, read, start, cancel and reply
 * to contracts, over every contract runner this daemon holds (its own and
 * each hosted-session workspace floor's). Handlers are in routes/contracts.ts;
 * each method also has a REST path, served through the daemon-sdk REST route
 * table (gateway-rest-routes.ts) by the same handler.
 *
 * Scopes follow the fleet methods: reading is `read:fleet`, acting is
 * `write:fleet`.
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import { methodDescriptor } from './method-catalog-shared.js';
import {
  CONTRACTS_CANCEL_INPUT_SCHEMA,
  CONTRACTS_CANCEL_OUTPUT_SCHEMA,
  CONTRACTS_GET_INPUT_SCHEMA,
  CONTRACTS_GET_OUTPUT_SCHEMA,
  CONTRACTS_LIST_INPUT_SCHEMA,
  CONTRACTS_LIST_OUTPUT_SCHEMA,
  CONTRACTS_REPLY_INPUT_SCHEMA,
  CONTRACTS_REPLY_OUTPUT_SCHEMA,
  CONTRACTS_START_INPUT_SCHEMA,
  CONTRACTS_START_OUTPUT_SCHEMA,
} from './operator-contract-schemas-contracts.js';

export const builtinGatewayContractMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'contracts.list',
    title: 'List Contracts',
    description: 'Every contract this daemon holds, newest first, each with its whole tree: the ask, the goal, the acceptance criteria with every Jev reading, the groups and units with their checks and nudges, open and answered owner escalations, decisions, usage, and the answer or status line once it ends. `sessionId` narrows the list to one session\'s contracts (a hosted session\'s, or a shared session\'s); ended contracts are left out unless `includeTerminal` is set.',
    category: 'contracts',
    scopes: ['read:fleet'],
    http: { method: 'GET', path: '/api/contracts' },
    inputSchema: CONTRACTS_LIST_INPUT_SCHEMA,
    outputSchema: CONTRACTS_LIST_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'contracts.get',
    title: 'Get a Contract',
    description: 'One contract with its whole tree, running or ended. 404 with CONTRACT_NOT_FOUND when no runner on this daemon holds the id.',
    category: 'contracts',
    scopes: ['read:fleet'],
    http: { method: 'GET', path: '/api/contracts/{contractId}' },
    inputSchema: CONTRACTS_GET_INPUT_SCHEMA,
    outputSchema: CONTRACTS_GET_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'contracts.start',
    title: 'Start a Contract',
    description: 'Start a contract for `ask`, the person\'s words verbatim, which every stated acceptance criterion must trace to. Returns at once with the new contract and its owner agent id; the contract shapes, plans and runs on its own, and its progress arrives on the `contracts` event domain. When `sessionId` names a live session this daemon hosts, the contract starts in that session (origin `hosted`): its turns receive the contract\'s questions and a following turn answers them. Otherwise it starts on the daemon\'s own runner (origin `external`) under `sessionId`, or the `operator` session when none is given, in `workspaceRoot` (absolute), or the daemon\'s working directory. `isolation` overrides `contract.isolation` for this contract.',
    category: 'contracts',
    scopes: ['write:fleet'],
    http: { method: 'POST', path: '/api/contracts' },
    inputSchema: CONTRACTS_START_INPUT_SCHEMA,
    outputSchema: CONTRACTS_START_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'contracts.cancel',
    title: 'Cancel a Contract',
    description: 'Stop a contract and every unit agent it runs; its status line records how many files were already changed and where. `cancelled` is false when the contract had already ended. 404 with CONTRACT_NOT_FOUND for an unknown id.',
    category: 'contracts',
    scopes: ['write:fleet'],
    http: { method: 'POST', path: '/api/contracts/{contractId}/cancel' },
    inputSchema: CONTRACTS_CANCEL_INPUT_SCHEMA,
    outputSchema: CONTRACTS_CANCEL_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'contracts.reply',
    title: 'Reply to a Contract Escalation',
    description: 'The owner\'s free-text reply to an open escalation of a contract, read by Jev as approve, reject, amend or unclear. Returns how it was read and what the runner did: approved, amended, stopped, asked again (with the new escalation id), or refused when the escalation is no longer open. Approval never passes a criterion Jev read as unmet; the requirement changes only through an amendment. 404 with CONTRACT_NOT_FOUND for an unknown id; 409 with CONTRACT_ENDED when the contract has ended.',
    category: 'contracts',
    scopes: ['write:fleet'],
    http: { method: 'POST', path: '/api/contracts/{contractId}/reply' },
    inputSchema: CONTRACTS_REPLY_INPUT_SCHEMA,
    outputSchema: CONTRACTS_REPLY_OUTPUT_SCHEMA,
  }),
];
