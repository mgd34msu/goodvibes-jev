// ---------------------------------------------------------------------------
// replication-policy-drift.test.ts, the two halves of one derivation.
//
// Cluster config replication decides WHICH credential belongs to a replicated
// setting by deriving the secret-store name from the config path. The SDK has
// its own copy of that derivation (`replicatedSecretKeyFor`), and this
// repository has another (`buildGoodVibesSecretKey` in src/config/secret-config.ts).
//
// Two copies of a rule is a rule that drifts. If they ever disagree, a
// credential either fails to replicate, a machine wins a surface it cannot
// serve, or a secret nobody intended to share is selected by a name the SDK
// derived and this repository did not. This pins them together.
//
// ── Why this test exists ──────────────────────────────────────────────────
//
// This repository carries its own byte-for-byte copy of secret-config.ts and
// had ZERO tests over it, so nothing pinned it against the SDK's copy on the
// side that actually does the replicating.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import {
  isReplicatedConfigPath,
  isReplicatedSecretKey,
  listReplicatedConfigPaths,
  replicatedSecretKeyFor,
} from '@goodvibes-jev/engine/sdk/platform/cluster';
import { buildGoodVibesSecretKey, SECRET_CONFIG_KEYS } from '../../config/secret-config.ts';

describe('the secret-name derivation', () => {
  test('agrees with this repository, for every path that replicates', () => {
    const paths = listReplicatedConfigPaths();
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(replicatedSecretKeyFor(path), `${path} derives a different secret name in the SDK`)
        .toBe(buildGoodVibesSecretKey(path));
    }
  });

  test('agrees on the awkward shapes too, not just the simple ones', () => {
    for (const path of ['surfaces.slack.botToken', 'a.b-c.d_e', 'surfaces.ntfy.topic', 'x']) {
      expect(replicatedSecretKeyFor(path)).toBe(buildGoodVibesSecretKey(path));
    }
  });

  test('and on every credential key this daemon routes through the secret tier', () => {
    // The set that matters most here: these are the keys whose VALUE this
    // process writes to the secret store and reads back by derived name. A
    // disagreement on one of them is a credential the cluster replicates under
    // a name this daemon never looks up.
    expect(SECRET_CONFIG_KEYS.size).toBeGreaterThan(0);
    for (const key of SECRET_CONFIG_KEYS) {
      expect(replicatedSecretKeyFor(key), `${key} derives a different secret name in the SDK`)
        .toBe(buildGoodVibesSecretKey(key));
    }
  });
});

describe('what this machine will accept from the group', () => {
  test('nothing machine-specific, so a replicated port can never collide', () => {
    // The concrete failure this rule exists to prevent: two daemons handed the
    // same control-plane port, the second of which cannot bind.
    expect(isReplicatedConfigPath('controlPlane.port')).toBe(false);
    expect(isReplicatedConfigPath('httpListener.port')).toBe(false);
    expect(isReplicatedConfigPath('cluster.port')).toBe(false);
    expect(isReplicatedConfigPath('cluster.enabled')).toBe(false);
  });

  test('and no client or user preference, whatever a peer claims', () => {
    expect(isReplicatedConfigPath('display.stream')).toBe(false);
    expect(isReplicatedConfigPath('provider.model')).toBe(false);
    expect(isReplicatedConfigPath('daemon.enabled')).toBe(false);
  });

  test('the group key material is not selectable as a replicated secret', () => {
    expect(isReplicatedSecretKey('cluster.groupMaterial')).toBe(false);
    expect(isReplicatedSecretKey(buildGoodVibesSecretKey('cluster.secret'))).toBe(false);
  });
});
