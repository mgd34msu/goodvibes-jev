import { BatteryRegistry } from '@goodvibes-jev/judgment';

/**
 * Every named decision the engine's build and pre-commit gates read through
 * Jev, for calibration:
 *
 *   bun run --cwd packages/judgment calibrate --registry ../engine/scripts/judgment-registry.ts
 */
export const registry = new BatteryRegistry();

// Whether a consumer-facing error doc still presents 'server' as an error kind.
import { staleServerKind } from './batteries/stale-server-kind.ts';
registry.register(staleServerKind);

import { deferredWork, internalIdentifier, staticOffendingAnchor } from './batteries/static-source.ts';
registry.register(internalIdentifier);
registry.register(deferredWork);
registry.register(staticOffendingAnchor);

import { staticWeakAnchor } from './batteries/static-weak-anchor.ts';
registry.register(staticWeakAnchor);
