/** Selected-command network ownership; never install or mutate global trust. */
import { applyOutboundTlsToFetchInit } from '@goodvibes-jev/engine/sdk/platform/runtime/transport';
import type { DaemonWebSocketFactory } from '@goodvibes-jev/engine/terminal-shell';
import type { RemoteCommandDeps } from './status-command.js';

/** Bun uses the same TLS options for HTTPS requests and WSS upgrades. */
export function createDaemonCommandSocketFactory(
  input: Pick<RemoteCommandDeps, 'configManager' | 'controlPlaneConfigDir'>,
): DaemonWebSocketFactory {
  const config = {
    get: (path: string) => input.configManager.get(path as Parameters<typeof input.configManager.get>[0]),
    getControlPlaneConfigDir: () => input.controlPlaneConfigDir,
  };
  return (url, init) => {
    const request = applyOutboundTlsToFetchInit(url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:'), init, config);
    return new WebSocket(url, request as unknown as string[]) as unknown as ReturnType<DaemonWebSocketFactory>;
  };
}
