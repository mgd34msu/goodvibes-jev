import { createOwnedTriagedInboxSource, registerTriagedInbox,
  type InboxSurfaceContext, type OwnedTriagedInboxOptions, type OwnedTriagedInboxSource,
  type OwnedInboxTriageResult, type InboxTriageAuthority, type InboxTriageOverlay,
} from '@goodvibes-jev/engine/sdk/platform/intake';
declare const context: InboxSurfaceContext;
declare const options: OwnedTriagedInboxOptions;
const source: Promise<OwnedTriagedInboxSource> = createOwnedTriagedInboxSource(context, options);
const registration: Promise<OwnedTriagedInboxSource> = registerTriagedInbox(context, options);
const score: Promise<OwnedInboxTriageResult> = source.then(owner => owner.runInboxTriage({ limit: 100 }, { dryRun: true }));
const authority: InboxTriageAuthority | undefined = options.authority;
declare const overlay: InboxTriageOverlay;
void [registration, score, authority, overlay];
