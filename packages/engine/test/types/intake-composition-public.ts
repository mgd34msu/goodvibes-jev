/** Consumer-vantage pin for additive source composition and legacy mail leases. */
import {
  createOwnedInboxSource, registerCompositeInboxSurface, registerInboxSurface,
  composeInboxReads, aggregateInbox,
  type InboxSurfaceContext, type RegisterInboxSurfaceOptions, type OwnedInboxSource,
  type InboxSurfaceRegistration, type InboxAggregatorSources, type EmailInboxOwner,
  type EmailInboxReadLease,
} from '@goodvibes-jev/engine/sdk/platform/intake';
import type { OperatorMethodOutputMap } from '@goodvibes-jev/engine/contracts';

declare const context: InboxSurfaceContext;
declare const options: RegisterInboxSurfaceOptions;
const source: OwnedInboxSource = createOwnedInboxSource(context, options);
const single: InboxSurfaceRegistration = registerInboxSurface(context, options);
const composite: InboxSurfaceRegistration = registerCompositeInboxSurface(context, [source]);
const captured = source.acquireRead(true);
const projected: Promise<OperatorMethodOutputMap['channels.inbox.list']> = captured.then(read => {
  const structural: InboxAggregatorSources = composeInboxReads([read]);
  read.assertCurrent();
  const output = aggregateInbox(structural, { limit: 50 });
  read.release();
  return output;
});

declare const email: EmailInboxOwner;
const legacyLease: Promise<() => Promise<void>> = email.acquireReadLease();
declare const proof: EmailInboxReadLease;
const asynchronousValidation: Promise<void> = proof();
export { source, single, composite, projected, legacyLease, asynchronousValidation };
