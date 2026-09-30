/** Public host aggregation stays assignable to the authoritative wire maps. */
import type { OperatorMethodInputMap, OperatorMethodOutputMap } from '@goodvibes-jev/engine/contracts';
import { aggregateInbox, normalizeInboxQuery, type InboxAggregatorSources, type InboxListInput } from '@goodvibes-jev/engine/sdk/platform/intake';

declare const sources: InboxAggregatorSources;
declare const input: InboxListInput;
const wireInput: OperatorMethodInputMap['channels.inbox.list'] = input;
const wireOutput: OperatorMethodOutputMap['channels.inbox.list'] = aggregateInbox(sources, normalizeInboxQuery(wireInput));
export { wireInput, wireOutput };
