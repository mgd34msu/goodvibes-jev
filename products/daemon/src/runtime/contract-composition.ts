/** The daemon composes one canonical runner after its plan and fleet owners exist. */
import { composeContractRunner, makeRuntimeFleetProbe, type ContractRunnerCompositionOptions } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import { createContractOperatorService } from '@goodvibes-jev/engine/sdk/platform/contract';

export type DaemonContractCompositionOptions = Omit<ContractRunnerCompositionOptions, 'fleetCapacity'> & {
  readonly acpHost: Parameters<typeof makeRuntimeFleetProbe>[0]['acpHost'];
};

export function createDaemonContractServices(options: DaemonContractCompositionOptions) {
  const { acpHost, ...dependencies } = options;
  const fleetCapacity = makeRuntimeFleetProbe({
    readConfig: (key) => options.configManager.get(key as Parameters<typeof options.configManager.get>[0]),
    agentManager: options.agentManager,
    acpHost,
  });
  const contracts = composeContractRunner({ ...dependencies, fleetCapacity });
  const operator = createContractOperatorService({ runner: contracts.runner, workingDirectory: options.projectRoot });
  return { ...contracts, operator };
}
