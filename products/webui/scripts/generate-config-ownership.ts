#!/usr/bin/env bun
/**
 * generate-config-ownership.ts
 *
 * Snapshots the SDK's config-ownership data, which config keys/prefixes the
 * daemon owns, into one checked-in, browser-safe TS module:
 *
 *   src/lib/generated/config-ownership.ts
 *
 * Why a generator (mirrors scripts/generate-config-schema.ts and
 * scripts/generate-presentation-tokens.ts): before this script existed,
 * src/lib/config-ownership.ts hand-copied DAEMON_OWNED_CONFIG_PREFIXES and
 * DAEMON_OWNED_CONFIG_KEYS from the SDK's
 * packages/sdk/src/platform/config/config-ownership.ts as a comment-enforced
 * "keep in sync by hand" mirror. It drifted: it was missing the
 * `conversationGate.` and `cluster.` prefixes, and it never carried
 * DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS at all (so keys like
 * `email.passwordRef` and `calendar.google.icsUrl`, daemon-owned per the SDK
 * because they hold mail/calendar credentials, read as NOT daemon-owned in
 * this UI's badge, even though the daemon is in fact the only writer). Because
 * routing happens server-side (daemon-config-route.ts), the drift never broke
 * routing, it just made the "daemon-owned" badge lie to the operator about
 * which settings the daemon owns.
 *
 * A hand-maintained mirror with a comment asking people to remember is not a
 * mechanism; this script is: it imports the real data tables from the
 * installed SDK at BUILD TIME (this script runs under bun/node, never inside
 * the Vite bundle) and snapshots them as plain literals. The browser only
 * ever imports the emitted literal, so importing
 * `@goodvibes-jev/engine/sdk/platform/config` here does not pull SecretsManager /
 * OAuth / google-auth into the bundle, same reasoning generate-config-schema.ts
 * already relies on for CONFIG_SCHEMA and FEATURE_SETTINGS.
 *
 * Regenerate with `bun run release:prepare`; `bun run generated:check`
 * verifies these snapshots against the workspace engine before every build.
 *
 * Usage:
 *   bun run scripts/generate-config-ownership.ts          # write/update
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DAEMON_OWNED_CONFIG_KEYS,
  DAEMON_OWNED_CONFIG_PREFIXES,
  DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS,
} from '@goodvibes-jev/engine/sdk/platform/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

export const TS_OUT_PATH = resolve(ROOT, 'src/lib/generated/config-ownership.ts');

// ---------------------------------------------------------------------------
// Snapshot shape, the exact serialisable data the ownership predicate needs.
// ---------------------------------------------------------------------------

export interface ConfigOwnershipSnapshot {
  readonly prefixes: readonly string[];
  readonly keys: readonly string[];
  readonly nonSchemaPaths: readonly string[];
}

/** Read the real ownership tables from the installed SDK. */
export function loadOwnershipSnapshot(): ConfigOwnershipSnapshot {
  return {
    prefixes: [...DAEMON_OWNED_CONFIG_PREFIXES],
    keys: [...DAEMON_OWNED_CONFIG_KEYS],
    nonSchemaPaths: [...DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS],
  };
}

// ---------------------------------------------------------------------------
// Rendering, pure, deterministic for a given snapshot.
// ---------------------------------------------------------------------------

const GENERATED_BANNER = [
  'GENERATED FILE. DO NOT EDIT BY HAND.',
  'Produced by scripts/generate-config-ownership.ts from the installed',
  '@goodvibes-jev/engine: DAEMON_OWNED_CONFIG_PREFIXES, DAEMON_OWNED_CONFIG_KEYS',
  'and DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS (platform/config).',
  '',
  'This is a build-time snapshot so the browser bundle never imports the SDK',
  'config barrel (which drags SecretsManager / OAuth / google-auth, node-only).',
  '',
  'Regenerate: `bun run config-ownership:generate`.',
  '`bun run generated:check` verifies it before every build.',
].join('\n * ');

export function renderTs(snapshot: ConfigOwnershipSnapshot): string {
  const json = (value: unknown): string => JSON.stringify(value, null, 2);
  const text = [
    `/**\n * ${GENERATED_BANNER}\n */`,
    '',
    `export const DAEMON_OWNED_CONFIG_PREFIXES: readonly string[] = ${json(snapshot.prefixes)} as const;`,
    '',
    `export const DAEMON_OWNED_CONFIG_KEYS: readonly string[] = ${json(snapshot.keys)} as const;`,
    '',
    `export const DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS: readonly string[] = ${json(snapshot.nonSchemaPaths)} as const;`,
    '',
  ].join('\n');
  return text.replace(/[ \t]+$/gm, '');
}

// ---------------------------------------------------------------------------
// CLI, regenerate the checked-in artifact.
// ---------------------------------------------------------------------------

export function writeIfChanged(path: string, content: string): boolean {
  let current: string | null;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    current = null;
  }
  if (current === content) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  console.log(`[config-ownership:generate] wrote: ${path}`);
  return true;
}

if (import.meta.main) {
  const snapshot = loadOwnershipSnapshot();
  const written = writeIfChanged(TS_OUT_PATH, renderTs(snapshot));
  console.log(written ? '[config-ownership:generate] done' : '[config-ownership:generate] up-to-date');
}
