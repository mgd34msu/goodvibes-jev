import { sha256 } from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';
import type { DaemonNativeTarget } from '../../cli/native-artifact.ts';
/** Metadata fixture for inert/synthetic interpreters; it does not claim actual ELF execution. */
export function nativeRuntimeProvenance(runtime: string, target: DaemonNativeTarget = 'linux-x64'): string {
  return JSON.stringify({ version: '1.3.14', target, source: 'build-interpreter', sha256: sha256(Buffer.from(runtime)),
    upstreamSource: 'https://github.com/oven-sh/bun/tree/bun-v1.3.14' });
}
