/**
 * Consumer-vantage compatibility pin for the optional integration reader.
 * Both legacy shapes compiled before integration inspection was introduced;
 * production factory results must still expose a callable, required reader.
 * Package imports intentionally exercise the published declaration surface.
 */
import {
  createContractRunner,
  type ContractRunner,
  type ContractRunnerDeps,
  type ContractIntegrationInspection,
  type OperatorContractRunner,
  type ContractCliRunner,
} from '@goodvibes-jev/engine/sdk/platform/contract';
import type {
  createNativeWorkExecutionHost,
  NativeWorkExecutionHost,
} from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution';

// Keep the historical attachment surface explicit: the new read capability
// must not become another prerequisite for already supported durable runners.
type LegacyNativeRunner = Pick<ContractRunner,
  'startDurable' | 'resumeDurable' | 'get' | 'list' | 'cancel' | 'join'
  | 'inspectDurable' | 'joinDurable'>;
declare const legacyNativeRunner: LegacyNativeRunner;
declare const host: ReturnType<typeof createNativeWorkExecutionHost>;
host.attachRunner(legacyNativeRunner);
const publicHost: NativeWorkExecutionHost = host;

// The full public interface must also accept a structural implementation that
// predates inspection, rather than repairing only the narrower attachment.
declare const legacyFullRunner: Omit<ContractRunner, 'inspectIntegration'>;
const customRunner: ContractRunner = legacyFullRunner;
host.attachRunner(customRunner);
const operatorRunner: OperatorContractRunner = legacyFullRunner;
const cliRunner: ContractCliRunner = legacyFullRunner;

// Optionality belongs to custom implementations, not to the real factory's
// result. Calling it without a guard must remain safe in consumer types.
declare const deps: ContractRunnerDeps;
const productionRunner = createContractRunner(deps);
const requiredReader: Required<Pick<ContractRunner, 'inspectIntegration'>> = productionRunner;
const inspection: ContractIntegrationInspection = productionRunner.inspectIntegration('contract-id');
host.attachRunner(productionRunner);

void publicHost; void customRunner; void operatorRunner; void cliRunner;
void requiredReader; void inspection;
