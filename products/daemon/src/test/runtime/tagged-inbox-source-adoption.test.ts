/** Real owner/source constructors; no polling, judgment or provider mutation is started by activation. */
import { afterEach, expect, test } from 'bun:test';
import { ConfigManager, createDaemonCredentialStore } from '@goodvibes-jev/engine/sdk/platform/config';
import { GatewayMethodCatalog } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { createSlackInboxOwner, createEmailInboxOwner, createOwnedInboxSource, type OwnedInboxTagging, type OwnedInboxSource } from '@goodvibes-jev/engine/sdk/platform/intake';
import type { ProtectedSourceOwnerOptions } from '@goodvibes-jev/engine/sdk/platform/security';
import { EmailService } from '@goodvibes-jev/engine/sdk/platform/email';
import { SecretsManager } from '../../config/secrets.js';
import { composeMailDeps } from '../../runtime/mail-composition.js';
import { createSlackDaemonInboxSourceFactory } from '../../runtime/slack-inbox-composition.js';
import { createEmailDaemonInboxSourceFactory } from '../../runtime/email-inbox-composition.js';
import type { HandlerContext } from '../../daemon/handlers/context.js';
import type { RoutingRegistration } from '../../daemon/handlers/index.js';
import type { DaemonInboxControls } from '../../runtime/daemon-handler-composition.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const screening: ProtectedSourceOwnerOptions = {
 authority: { ownerId: 'synthetic-local-screening', revision: 'one', retention: 'ephemeral-no-log', signal: new AbortController().signal, assertCurrent() {} },
 proposal: { endpoint: 'http://127.0.0.1:9', model: 'synthetic-no-call' }, judgment: { endpoint: 'http://127.0.0.1:9', model: 'jev-1.13.0' },
};
const routing = { resolveProfileId() { return undefined; } } as unknown as RoutingRegistration;
function fixture() {
 const root = makeOwnedTempDir('tagged-source-adoption');
 const config = new ConfigManager({ workingDir: root, homeDir: root, surfaceRoot: 'daemon' }); config.set('cluster.enabled', false);
 const secrets = new SecretsManager({ projectRoot: root, globalHome: root, daemonHome: root });
 const context: HandlerContext = { configManager: config, credentials: createDaemonCredentialStore(secrets), catalog: new GatewayMethodCatalog(), workingDirectory: root, homeDirectory: root, logger: { info() {}, warn() {}, error() {} } };
 let creates = 0, mutations = 0, tagCloses = 0; const requests: Parameters<NonNullable<DaemonInboxControls['createTriageTagging']>>[0][] = [];
 const controls: DaemonInboxControls = { gatePolling() {}, onAccountInvalidation() { return () => {}; }, createTriageTagging(request) {
   creates++; requests.push(request); return { async applyTags() { mutations++; }, async close() { tagCloses++; } };
 } };
 return { config, secrets, context, controls, requests, get creates() { return creates; }, get mutations() { return mutations; }, get tagCloses() { return tagCloses; } };
}
test('configured Slack source opt-in adopts the real owner scope; activation itself does not poll or mutate', async () => {
 const f = fixture(); f.config.set('surfaces.slack.enabled', true); f.config.set('surfaces.slack.workspaceId', 'T123');
 let scope = '', delivered: OwnedInboxTagging | undefined, owned: OwnedInboxSource | undefined;
 const factory = createSlackDaemonInboxSourceFactory({ account: { workspaceId: 'T123', userId: 'U123' }, screening, triageTagging: { onReady(owner) { delivered = owner; } } }, {
   async createOwner(context, options) { const owner = await createSlackInboxOwner(context, options); scope = owner.scopeId; return owner; },
   createSource(context, options) { owned = createOwnedInboxSource(context, { ...options, skipInitialPoll: true }); return owned; },
 });
 const surface = await factory(f.context, routing, f.controls); cleanups.push(() => surface.close()); await surface.ready;
 expect(delivered).toBeDefined(); expect(f.creates).toBe(1); expect(f.requests[0]!.accountScopeId).toBe(scope); expect(f.requests[0]!.source.providerIds).toEqual(['slack']); expect(f.requests[0]!.source.acquireRead).toBe(owned!.acquireRead); expect(f.mutations).toBe(0);
 await surface.close(); expect(f.tagCloses).toBe(1);
});
test('configured email opt-in derives exact TLS mailbox target from the real owner account', async () => {
 const f = fixture(); f.config.set('surfaces.email.host', 'mail.synthetic.invalid'); f.config.set('surfaces.email.user', 'owner@synthetic.invalid');
 const account = { host: 'mail.synthetic.invalid', port: 993, username: 'owner@synthetic.invalid', mailbox: 'INBOX', security: 'tls' as const };
 let delivered: OwnedInboxTagging | undefined, scope = '';
 const factory = createEmailDaemonInboxSourceFactory({ account, screening, triageTagging: { onReady(owner) { delivered = owner; } } }, {
   createOwner(options) { const owner = createEmailInboxOwner(options); scope = owner.scopeId; return owner; },
   createSource(context, options) { return createOwnedInboxSource(context, { ...options, skipInitialPoll: true }); },
 });
 const surface = await factory(f.context, routing, { ...f.controls, createEmailService() {
   const disposers: Array<() => void> = [];
   const { emailServiceDeps } = composeMailDeps({ configManager: f.config, secretsManager: f.secrets, registerDispose: dispose => { disposers.push(dispose); } });
   return { service: new EmailService(emailServiceDeps), close() { for (const dispose of disposers.splice(0).reverse()) dispose(); } };
 } });
 cleanups.push(() => surface.close()); await surface.ready; expect(delivered).toBeDefined();
 expect(f.requests[0]).toMatchObject({ provider: 'email', accountScopeId: scope, imap: { host: account.host, port: 993, user: account.username, mailbox: 'INBOX' } }); expect(f.mutations).toBe(0);
});
test('unrequested tagging stays absent and missing canonical capability refuses before owner creation', async () => {
 const f = fixture(); f.config.set('surfaces.slack.enabled', true); f.config.set('surfaces.slack.workspaceId', 'T123');
 let made = 0;
 const factories = { async createOwner(context: Parameters<typeof createSlackInboxOwner>[0], options: Parameters<typeof createSlackInboxOwner>[1]) { made++; return createSlackInboxOwner(context, options); }, createSource(context: Parameters<typeof createOwnedInboxSource>[0], options: Parameters<typeof createOwnedInboxSource>[1]) { return createOwnedInboxSource(context, { ...options, skipInitialPoll: true }); } };
 const options = { account: { workspaceId: 'T123', userId: 'U123' }, screening };
 const source = await createSlackDaemonInboxSourceFactory(options, factories)(f.context, routing, f.controls); await source.ready; await source.close(); expect(f.creates).toBe(0);
 await expect(createSlackDaemonInboxSourceFactory({ ...options, triageTagging: { onReady() {} } }, factories)(f.context, routing, { gatePolling() {} })).rejects.toThrow('canonical'); expect(made).toBe(1);
});
