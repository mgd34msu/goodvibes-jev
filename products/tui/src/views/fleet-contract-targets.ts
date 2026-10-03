import type { ProcessNode } from '@goodvibes-jev/engine/sdk/platform/runtime/fleet';
import { isTerminalContractStatus, type ContractView } from '@goodvibes-jev/engine/sdk/platform/contract';

/** Only the root adapter records ownership of the contract's working tree. */
export function rootContractFromNode(node: ProcessNode): ContractView | null {
  if (node.kind !== 'contract') return null;
  const contract = node.raw as ContractView | undefined;
  return contract?.id && node.id === `contract:${contract.id}` ? contract : null;
}

/** Never advertise discard for a live contract or borrow its path from a unit. */
export function discardableContractWorktree(node: ProcessNode): string | null {
  const contract = rootContractFromNode(node);
  return contract && isTerminalContractStatus(contract.status) && typeof contract.worktreePath === 'string' && contract.worktreePath.length > 0
    ? contract.worktreePath : null;
}
