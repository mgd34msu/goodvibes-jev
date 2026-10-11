import { JudgmentAuthorityRetiredError, type JudgmentAuthorityFrame } from '@goodvibes-jev/engine/errors';
import type { JudgmentSettingsSource } from './judgment-services.js';

/**
 * The real composition owns this observation. Credential values are compared
 * only inside this closure; they never become cache identities or log facts.
 * Config/credential mutation intent invalidates before publication, including
 * ABA and failed/no-op mutation. Raw legacy sources without observers retain
 * their value-snapshot contract, not a fabricated ABA guarantee.
 */
export function createJudgmentSourceLifetime(source: JudgmentSettingsSource): {
  readonly capture: () => JudgmentAuthorityFrame;
  readonly dispose: () => void;
} {
  let identity = Object.freeze({});
  let controller = new AbortController();
  let previous: readonly unknown[] | undefined;
  let disposed = false;
  const invalidate = () => {
    const old = controller;
    identity = Object.freeze({}); controller = new AbortController(); previous = undefined;
    old.abort();
  };
  const configUnsubscribe = source.config.onDidChangeIncarnation?.(invalidate);
  const secretUnsubscribe = source.secrets.onDidInvalidateCredentials?.(invalidate);

  const sample = () => {
    if (disposed) throw new JudgmentAuthorityRetiredError();
    const configBefore = source.config.getConfigurationIncarnation?.();
    const secretBefore = source.secrets.getCredentialMutationState?.();
    const observation = [configBefore, secretBefore?.generation,
      source.config.get('judgment.endpoint'), source.config.get('judgment.keySource'),
      source.config.get('judgment.model'), source.config.get('judgment.timeoutMs'),
      source.env['TYPESAFE_BASE_URL'], source.env['TYPESAFE_DEFAULT_MODEL'], source.env['TYPESAFE_API_KEY']];
    const configAfter = source.config.getConfigurationIncarnation?.();
    const secretAfter = source.secrets.getCredentialMutationState?.();
    if (disposed || configBefore !== configAfter || secretBefore?.generation !== secretAfter?.generation
      || secretBefore?.pending || secretAfter?.pending) {
      invalidate(); throw new JudgmentAuthorityRetiredError();
    }
    if (previous && previous.some((value, index) => value !== observation[index])) invalidate();
    previous = observation;
  };

  return {
    capture() {
      sample();
      const captured = identity;
      const signal = controller.signal;
      return Object.freeze({ identity: captured, signal, assertCurrent() {
        sample();
        if (signal.aborted || identity !== captured) throw new JudgmentAuthorityRetiredError();
      } });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      configUnsubscribe?.(); secretUnsubscribe?.();
      previous = undefined;
      controller.abort();
    },
  };
}
