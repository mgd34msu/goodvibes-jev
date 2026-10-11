/** Original setup request ownership survives every outer await and storage call. */
import { assertGoogleReadingCurrent, ownGoogleBrowser, GoogleReadingError } from './browser-readings.js';
import { GoogleSetupWriteCommittedError, type GoogleMutationOwnership } from './setup-effect.js';
import type { GoogleSetupActionDeps } from './setup-action-deps.js';

export function ownGoogleSetupDeps(deps: GoogleSetupActionDeps): GoogleSetupActionDeps {
  const config = deps.config, secrets = deps.secrets, factory = deps.browser;
  const configGet = config.get, configSet = config.set, secretGet = secrets.get, secretSet = secrets.set;
  const options = { signal: deps.signal, assertCurrent: deps.assertCurrent };
  let originalBrowser: Awaited<ReturnType<typeof factory>> | undefined;
  let observation: ReturnType<typeof ownGoogleBrowser> | undefined;
  let installationCurrent: (() => void) | undefined;
  let mutating = false;
  let observationEpoch = 0;
  function requestCurrent() {
    assertGoogleReadingCurrent(options);
    if (deps.config !== config || deps.secrets !== secrets || deps.browser !== factory
      || config.get !== configGet || config.set !== configSet || secrets.get !== secretGet || secrets.set !== secretSet) throw new GoogleReadingError();
    installationCurrent?.();
  }
  function current() {
    requestCurrent();
    if (mutating) throw new GoogleReadingError();
    observation?.assertCurrent();
  }
  function mutation(): GoogleMutationOwnership {
    let consumed = false, committed = false;
    return Object.freeze({
      assertCurrent: () => { if (committed) throw new GoogleReadingError(); consumed ? requestCurrent() : current(); },
      consumeObservation: () => {
        if (consumed || committed) throw new GoogleReadingError(); current(); consumed = true;
        if (observation) { installationCurrent = observation.consumeObservation().assertCurrent; observation = undefined; }
        observationEpoch += 1; mutating = true;
      },
      committed: () => {
        if (!consumed || committed) throw new GoogleReadingError();
        requestCurrent(); committed = true; mutating = false;
      },
    });
  }
  return { ...deps, assertCurrent: current,
    browser: async () => {
      current(); const raw = await factory(); current();
      if (originalBrowser && originalBrowser !== raw) throw new GoogleReadingError();
      originalBrowser = raw;
      const epoch = observationEpoch;
      const owned = ownGoogleBrowser(raw, { signal: options.signal, assertCurrent: () => {
        if (epoch !== observationEpoch) throw new GoogleReadingError(); current();
      } });
      // Do not recurse through current: each browser's owner carries the
      // request guard, while later writes keep the first installed authority.
      if (!observation) observation = ownGoogleBrowser(raw, options);
      current(); return owned.browser;
    },
    config: { get: key => { current(); const value = configGet.call(config, key); current(); return value; },
      set: (key, value) => { current(); configSet.call(config, key, value, mutation()); current(); } },
    secrets: { get: async key => { current(); const value = await secretGet.call(secrets, key); current(); return value; },
      set: async (key, value) => { current(); await secretSet.call(secrets, key, value, mutation()); current(); },
      ...(secrets.delete ? { delete: async (key: string) => { current(); await secrets.delete!(key); current(); } } : {}),
    },
  };
}

/** Publish a step result only while the same request and observation survive. */
export function ownGoogleSetupRunners(
  runners: ReadonlyMap<import('./types.js').GoogleStepId, import('./setup-flow.js').GoogleStepRunner>,
  deps: GoogleSetupActionDeps,
): ReadonlyMap<import('./types.js').GoogleStepId, import('./setup-flow.js').GoogleStepRunner> {
  return new Map([...runners].map(([id, runner]) => [id, async spec => {
    assertGoogleReadingCurrent(deps);
    try {
      const result = await runner(spec);
      assertGoogleReadingCurrent(deps);
      return result;
    } catch (error) {
      if (error instanceof GoogleSetupWriteCommittedError) return { outcome: 'failed' as const,
        detail: error.message, problem: 'Further setup work was stopped; the committed write was preserved.', fix: 'Review the current setup state before continuing.' };
      throw error;
    }
  }]));
}
