/** Bind each connection attempt to the actual configured account and credential generation. */
import type { JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { assertImapReadingCurrent, ImapReadingError } from '../imap-readings.js';
import { readSurfaceEmailSettings } from '../surface-config.js';
import type { InboundMailSourceFactoryDeps } from './source-factory.js';

export function beginImapSourceReading(deps: InboundMailSourceFactoryDeps, owner: JudgmentReadingOptions): {
  readonly reading: JudgmentReadingOptions;
  dispose(): void;
} {
  const retired = new AbortController();
  const invalidate = () => retired.abort();
  const configOff = deps.onDidChangeConfiguration?.(invalidate);
  const secretsOff = deps.secrets.onDidInvalidateCredentials?.(invalidate);
  const dispose = () => { configOff?.(); secretsOff?.(); retired.abort(); };
  try {
    const source = JSON.stringify(readSurfaceEmailSettings(deps.getConfig));
    const policy = deps.getConfig('surfaces.email.inbound.onInsufficientCapability');
    const incarnation = deps.getConfigurationIncarnation?.();
    const credentials = deps.secrets.getCredentialMutationState?.();
    const signal = AbortSignal.any([retired.signal, ...(owner.signal ? [owner.signal] : [])]);
    const reading = { signal, assertCurrent: () => {
      assertImapReadingCurrent(owner);
      const currentCredentials = deps.secrets.getCredentialMutationState?.();
      if (signal.aborted || incarnation !== deps.getConfigurationIncarnation?.()
        || credentials?.pending || currentCredentials?.pending
        || credentials?.generation !== currentCredentials?.generation
        || policy !== deps.getConfig('surfaces.email.inbound.onInsufficientCapability')
        || source !== JSON.stringify(readSurfaceEmailSettings(deps.getConfig))) {
        retired.abort();
        throw new ImapReadingError();
      }
    } };
    assertImapReadingCurrent(reading);
    return { reading, dispose };
  } catch { dispose(); throw new ImapReadingError(); }
}
