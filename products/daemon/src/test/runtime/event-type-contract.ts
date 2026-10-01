import type { ContractEvent, GateEvent } from '../../runtime/index.ts';
import type { ContractEvent as EngineContractEvent, GateEvent as EngineGateEvent } from '@goodvibes-jev/engine/sdk/events';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
export type ContractDomainMatches = Assert<Equal<ContractEvent, EngineContractEvent>>;
export type GateDomainMatches = Assert<Equal<GateEvent, EngineGateEvent>>;

// @ts-expect-error The removed orchestration event union is not a contract alias.
import type { OrchestrationEvent } from '../../runtime/index.ts';
// @ts-expect-error The removed permission event union is not a gate alias.
import type { PermissionEvent } from '../../runtime/index.ts';
// @ts-expect-error The removed workflow event union is not a contract alias.
import type { WorkflowEvent } from '../../runtime/index.ts';
