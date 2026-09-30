import { createAsyncDisposalScope, createDisposalScope, type AsyncDisposalScope, type DisposalRegistry } from '@goodvibes-jev/engine/sdk/platform/runtime/disposal';

const scope: AsyncDisposalScope = createAsyncDisposalScope('consumer fixture');
const compatibleRegistry: DisposalRegistry = scope.registry;
compatibleRegistry.add('sync owner', () => {});
scope.registry.add('async owner', async () => {});
const legacyInvocation: void = scope.dispose();
const drained: Promise<void> = scope.close();
const unchangedLegacy = createDisposalScope('legacy fixture');
const legacyResult: void = unchangedLegacy.dispose();
// @ts-expect-error Existing synchronous scopes do not silently gain async ownership guarantees.
unchangedLegacy.close();
export { scope, compatibleRegistry, legacyInvocation, drained, unchangedLegacy, legacyResult };
