/** Private bridge across the runtime/server construction order; no authority escapes. */
import type { GatewayMethodCatalog } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import type { DaemonHostedSessionsOptions } from '@goodvibes-jev/engine/sdk/platform/daemon';
type Owner = NonNullable<DaemonHostedSessionsOptions['nativeConversation']>;
const owners = new WeakMap<GatewayMethodCatalog, Owner>();
export function installNativeHostedConversationOwner(catalog: GatewayMethodCatalog, owner: Owner): () => void {
  if (owners.has(catalog)) throw new Error('Native hosted conversation owner already installed');
  owners.set(catalog, owner);
  return () => { owners.delete(catalog); };
}
export function nativeHostedConversationOwner(catalog: GatewayMethodCatalog): Owner | undefined { return owners.get(catalog); }
