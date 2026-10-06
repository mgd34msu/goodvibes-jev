/** Generated hosted records retain the producer's optional metadata and literal ownership marker. */
import type { OperatorMethodInput, OperatorMethodOutput } from '@goodvibes-jev/engine/contracts';
import type { HostedSessionRecord } from '@goodvibes-jev/engine/sdk/platform/hosted-sessions';

type SessionMethod = 'sessions.hosted.attach' | 'sessions.hosted.create' | 'sessions.hosted.detach' | 'sessions.hosted.kill';
type GeneratedRecord = OperatorMethodOutput<SessionMethod>['session']
  | OperatorMethodOutput<'sessions.hosted.list'>['sessions'][number];

declare const record: GeneratedRecord;
const surface: HostedSessionRecord['originSurface'] = record.originSurface;
const nativeConversation: HostedSessionRecord['nativeConversation'] = record.nativeConversation;
const create: OperatorMethodInput<'sessions.hosted.create'> = { workspaceRoot: '/workspace', originSurface: 'webui' };
const legacyCreate: OperatorMethodInput<'sessions.hosted.create'> = { workspaceRoot: '/workspace' };

// Both metadata fields remain optional for records persisted before they existed.
const legacyMetadata: Pick<GeneratedRecord, 'originSurface' | 'nativeConversation'> = {};
// @ts-expect-error A native classification is a host-written true marker, never false.
const falseOwnership: GeneratedRecord['nativeConversation'] = false;
// @ts-expect-error Origin surface is text, not an arbitrary JSON value.
const nonTextSurface: GeneratedRecord['originSurface'] = 42;
// @ts-expect-error The generated record stays closed to undeclared metadata.
const inventedField = record.inventedField;

export { surface, nativeConversation, create, legacyCreate, legacyMetadata, falseOwnership, nonTextSurface, inventedField };
