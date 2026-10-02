/** Consumer-vantage pin: resolve only the supported, narrow package subpath. */
import {
  createEmptyWorkLedgerState,
  createWorkLedger,
  WorkLedgerAccessError,
  workLedgerCommandSchema,
  workLedgerStateSchema,
  type WorkLedgerActor,
  type WorkLedgerAuthority,
  type WorkLedgerClock,
  type WorkLedgerCommand,
  type WorkLedgerDecision,
  type WorkLedgerEvent,
  type WorkLedgerHostIdentity,
  type WorkLedgerResult,
  type WorkLedgerService,
  type WorkLedgerSnapshot,
  type WorkLedgerState,
  type WorkLedgerStorage,
} from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger';
import * as sdkRoot from '@goodvibes-jev/engine/sdk';
import * as workflow from '@goodvibes-jev/engine/sdk/platform/workflow';

declare const storage: WorkLedgerStorage;
declare const clock: WorkLedgerClock;
const initial: WorkLedgerState = createEmptyWorkLedgerState('consumer-project');
const validated: WorkLedgerState = workLedgerStateSchema.parse(initial);
const { service, authority }: {
  readonly service: WorkLedgerService;
  readonly authority: WorkLedgerAuthority;
} = createWorkLedger({ projectId: initial.projectId, storage, clock });
const identity: WorkLedgerHostIdentity = {
  actorId: 'coordinator', projectId: initial.projectId, role: 'coordinator',
};
const actor: WorkLedgerActor = authority.issueActor(identity);
const command: WorkLedgerCommand = workLedgerCommandSchema.parse({
  type: 'create', requestId: 'create-1', expectedRevision: 0,
  title: 'Consumer fixture', goal: 'Use the supported host seam',
  criteria: ['Public imports resolve'],
});
const result: Promise<WorkLedgerResult> = service.execute(command, actor, {
  signal: new AbortController().signal,
});
const snapshot: Promise<WorkLedgerSnapshot> = service.readSnapshot(actor);
const history: Promise<readonly WorkLedgerEvent[]> = service.history(0, actor);
const unsubscribe: () => void = service.subscribe(actor, (next) => {
  const revision: number = next.revision;
  void revision;
});
const closed: Promise<void> = service.close();
const admissionError: WorkLedgerAccessError = new WorkLedgerAccessError('forbidden', 'Access revoked');
const decision: WorkLedgerDecision<number> = { next: initial, value: initial.revision };
const persistedRevision: Promise<number> = storage.transaction(() => decision);

// Actor handles cannot be forged from editable host identity data.
// @ts-expect-error The opaque actor brand is minted only by trusted authority.
const forgedActor: WorkLedgerActor = identity;
// @ts-expect-error Consumer service does not grant host authority.
service.issueActor(identity);
// @ts-expect-error Storage decisions are synchronous at the linearization point.
storage.transaction(async () => decision);
// @ts-expect-error The broad SDK root deliberately does not export this host seam.
sdkRoot.createWorkLedger;
// @ts-expect-error The existing workflow barrel remains a separate surface.
workflow.createWorkLedger;

/** All three outcomes remain distinguishable without unsafe assertions. */
export function describeReceipt(receipt: WorkLedgerResult): string {
  switch (receipt.kind) {
    case 'accepted': return `${receipt.event.sequence}:${receipt.replayed}`;
    case 'rejected': return `${receipt.code}:${receipt.revision}`;
    case 'indeterminate': return `${receipt.actorId}:${receipt.requestId}`;
    default: {
      const exhaustive: never = receipt;
      return exhaustive;
    }
  }
}

export {
  initial, validated, actor, command, result, snapshot, history, unsubscribe,
  closed, admissionError, persistedRevision, forgedActor,
};

// Read-only consumer capability: actor and owner are captured by trusted host.
import {
  createLocalWorkLedgerReadBinding,
  type WorkLedgerReadBinding,
  type WorkLedgerReadClient,
  type WorkLedgerReadSnapshot,
} from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger';
const readBinding: WorkLedgerReadBinding = createLocalWorkLedgerReadBinding({
  available: true, projectId: initial.projectId, actorId: 'reader', service, authority,
});
if (readBinding.available) {
  const reader: WorkLedgerReadClient = readBinding.client;
  const readSnapshot: Promise<WorkLedgerReadSnapshot> = reader.readSnapshot();
  void readSnapshot;
  // @ts-expect-error A read capability does not expose mutation.
  reader.execute(command, actor);
  // @ts-expect-error A read capability does not expose authority.
  reader.authority;
  // @ts-expect-error Disposal cannot close the shared host service.
  reader.close();
  // @ts-expect-error The host-selected project binding is immutable.
  reader.projectId = 'another-project';
  void reader.readSnapshot().then(view => {
    // @ts-expect-error Read views do not advertise mutation affordances.
    view.works[0]?.allowedActions;
  });
}
// @ts-expect-error No broad root export for the local host binding seam.
sdkRoot.createLocalWorkLedgerReadBinding;
// @ts-expect-error No broad workflow export for the local host binding seam.
workflow.createLocalWorkLedgerReadBinding;
