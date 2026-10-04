/** The daemon composes one canonical runner after its plan and fleet owners exist. */
import { composeContractRunner, makeRuntimeFleetProbe, type ContractRunnerCompositionOptions } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import { createContractOperatorService } from '@goodvibes-jev/engine/sdk/platform/contract';

export type DaemonContractCompositionOptions = Omit<ContractRunnerCompositionOptions, 'fleetCapacity'> & {
  readonly acpHost: { list(): readonly { readonly id: string }[] };
  /** Trusted sibling execution graphs, not observed external processes. */
  readonly additionalFleetOwnership?: (() => ReturnType<ContractRunnerCompositionOptions['agentManager']['fleetOwnership']>) | undefined;
};

export function createDaemonContractServices(options: DaemonContractCompositionOptions) {
  const { acpHost, additionalFleetOwnership, ...dependencies } = options;
  const fleetCapacity = makeRuntimeFleetProbe({
    readConfig: (key) => options.configManager.get(key as Parameters<typeof options.configManager.get>[0]),
    agentManager: additionalFleetOwnership ? { list: () => {
      const active = new Set([...options.agentManager.fleetOwnership(), ...additionalFleetOwnership()].filter(agent => agent.active).map(agent => agent.id));
      return [...active].map(id => ({ id, status: 'running' }));
    } } : options.agentManager,
    acpHost,
  });
  const contracts = composeContractRunner({ ...dependencies, fleetCapacity });
  const operator = createContractOperatorService({ runner: contracts.runner, workingDirectory: options.projectRoot });
  return { ...contracts, operator };
}
