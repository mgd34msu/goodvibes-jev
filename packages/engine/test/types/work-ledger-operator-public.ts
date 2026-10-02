/** Consumer-vantage type identity pin for the separate remote read subpath. */
import { createOperatorWorkLedgerReadClient, type OperatorWorkLedgerReadOptions } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/operator-read-client';
import type { OperatorRemoteClient } from '@goodvibes-jev/engine/operator-sdk';
import type { WorkLedgerReadClient, WorkLedgerReadSnapshot } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger';

declare const operator: Pick<OperatorRemoteClient, 'invoke'>;
const options: OperatorWorkLedgerReadOptions = { pollIntervalMs: 1_000, requestTimeoutMs: 2_000, onUnavailable: () => {} };
const reader: WorkLedgerReadClient = createOperatorWorkLedgerReadClient(operator, 'consumer-project', options);
const snapshot: Promise<WorkLedgerReadSnapshot> = reader.readSnapshot();
const detach: () => void = reader.subscribe(() => {});
detach(); reader.dispose(); void snapshot;
// @ts-expect-error A read transport exposes no mutation capability.
reader.execute({ type: 'create' });
// @ts-expect-error Host authority is never exposed to a consumer.
reader.authority.issueActor({});
