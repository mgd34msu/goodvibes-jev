#!/usr/bin/env bun
/**
 * generate-config-schema.ts
 *
 * Snapshots the two SDK data tables the settings surface renders from, the
 * typed config schema and the per-feature settings metadata, into one
 * checked-in, browser-safe TS module:
 *
 *   src/lib/generated/config-schema.ts
 *
 * Why a generator (mirrors scripts/generate-presentation-tokens.ts): the SDK's
 * `@goodvibes-jev/engine/sdk/platform/config` barrel re-exports CONFIG_SCHEMA but
 * ALSO pulls SecretsManager, OAuth listeners, google-auth, etc., node-only code
 * that must never enter the browser Vite bundle. Snapshotting the pure data at
 * build time keeps those heavy barrels out of the bundle entirely; the browser
 * imports only the emitted literal.
 *
 * Data sources:
 *   - CONFIG_SCHEMA, from the exported `@goodvibes-jev/engine/sdk/platform/config`
 *     subpath (types / enums / defaults / descriptions / validation hints per
 *     key). The `validate` closures are dropped (not serialisable); the daemon's
 *     config.set is the authoritative validator, and `validationHint` carries the
 *     human-readable constraint into the UI.
 *   - FEATURE_SETTINGS, from the SDK's public
 *     `@goodvibes-jev/engine/sdk/platform/runtime/feature-flags` subpath export:
 *     every platform capability as a first-class domain setting (name, real
 *     description, domain, enablement shape, owned settings keys, restart
 *     requirement, stock default). There is no separate enablement namespace,
 *     features are configured through their domain settings keys.
 *     Nothing here reaches the browser bundle (this script only runs at build
 *     time, via config-schema:generate).
 *
 * Regenerate with `bun run release:prepare`; `bun run generated:check`
 * verifies these snapshots against the workspace engine before every build.
 *
 * Usage:
 *   bun run scripts/generate-config-schema.ts          # write/update
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_SCHEMA } from '@goodvibes-jev/engine/sdk/platform/config';
import { FEATURE_SETTINGS } from '@goodvibes-jev/engine/sdk/platform/runtime/feature-flags';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

export const TS_OUT_PATH = resolve(ROOT, 'src/lib/generated/config-schema.ts');

// ---------------------------------------------------------------------------
// Snapshot shapes, the exact serialisable rows the settings model consumes.
// ---------------------------------------------------------------------------

export interface ConfigSchemaEntrySnapshot {
  readonly key: string;
  readonly type: 'boolean' | 'number' | 'string' | 'enum' | 'object';
  readonly default: unknown;
  readonly description: string;
  readonly enumValues?: readonly string[];
  readonly validationHint?: string;
  /**
   * What kind of quantity a `number` key holds, when that changes how a value
   * is read or shown. `'money'` marks a key holding a plain amount of
   * `payments.currency`, written the way a person says it (SDK 2.0.5's
   * money-value.ts), the mark a surface asks the SCHEMA for instead of
   * pattern-matching the key's NAME, which is exactly what tied every
   * consumer to a naming scheme and broke them all when the names changed.
   */
  readonly unit?: 'money';
}

export interface FeatureSettingSnapshot {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly domain: string;
  readonly enablement: {
    readonly key: string;
    readonly kind: 'boolean' | 'enum' | 'constant';
    readonly enabledValues?: readonly string[];
  };
  readonly settings: readonly string[];
  readonly restartRequired: boolean;
  readonly defaultEnabled: boolean;
}

export interface ConfigSchemaSnapshot {
  readonly entries: ConfigSchemaEntrySnapshot[];
  readonly features: FeatureSettingSnapshot[];
}

/** Read the real schema + feature-settings tables from the installed SDK. */
export async function loadSchemaSnapshot(): Promise<ConfigSchemaSnapshot> {
  const entries: ConfigSchemaEntrySnapshot[] = CONFIG_SCHEMA.map((s) => ({
    key: s.key,
    type: s.type,
    default: s.default,
    description: s.description,
    ...(s.enumValues ? { enumValues: [...s.enumValues] } : {}),
    ...(s.validationHint ? { validationHint: s.validationHint } : {}),
    ...(s.unit ? { unit: s.unit } : {}),
  }));

  const features: FeatureSettingSnapshot[] = FEATURE_SETTINGS.map((f) => ({
    id: f.id,
    name: f.name,
    description: f.description,
    domain: f.domain,
    enablement: {
      key: f.enablement.key,
      kind: f.enablement.kind,
      ...(f.enablement.enabledValues ? { enabledValues: [...f.enablement.enabledValues] } : {}),
    },
    settings: [...f.settings],
    restartRequired: f.restartRequired,
    defaultEnabled: f.defaultEnabled,
  }));

  return { entries, features };
}

// ---------------------------------------------------------------------------
// Rendering, pure, deterministic for a given snapshot.
// ---------------------------------------------------------------------------

const GENERATED_BANNER = [
  'GENERATED FILE. DO NOT EDIT BY HAND.',
  'Produced by scripts/generate-config-schema.ts from the installed',
  "@goodvibes-jev/engine: CONFIG_SCHEMA (platform/config) plus the per-feature",
  'settings metadata (FEATURE_SETTINGS, platform/runtime/feature-flags).',
  '',
  'This is a build-time snapshot so the browser bundle never imports the SDK',
  "config barrel (which drags SecretsManager / OAuth / google-auth, node-only).",
  '',
  'Regenerate: `bun run config-schema:generate`.',
  '`bun run generated:check` verifies it before every build.',
].join('\n * ');

export function renderTs(snapshot: ConfigSchemaSnapshot): string {
  const json = (value: unknown): string => JSON.stringify(value, null, 2);
  const text = [
    `/**\n * ${GENERATED_BANNER}\n */`,
    '',
    'export interface ConfigSchemaEntry {',
    '  readonly key: string;',
    "  readonly type: 'boolean' | 'number' | 'string' | 'enum' | 'object';",
    '  readonly default: unknown;',
    '  readonly description: string;',
    '  readonly enumValues?: readonly string[];',
    '  readonly validationHint?: string;',
    "  readonly unit?: 'money';",
    '}',
    '',
    "export type FeatureEnablementKind = 'boolean' | 'enum' | 'constant';",
    '',
    'export interface FeatureSettingMeta {',
    '  readonly id: string;',
    '  readonly name: string;',
    '  readonly description: string;',
    '  readonly domain: string;',
    '  readonly enablement: {',
    '    readonly key: string;',
    '    readonly kind: FeatureEnablementKind;',
    '    readonly enabledValues?: readonly string[];',
    '  };',
    '  readonly settings: readonly string[];',
    '  readonly restartRequired: boolean;',
    '  readonly defaultEnabled: boolean;',
    '}',
    '',
    `export const CONFIG_SCHEMA_ENTRIES: readonly ConfigSchemaEntry[] = ${json(snapshot.entries)} as const;`,
    '',
    `export const FEATURE_SETTINGS: readonly FeatureSettingMeta[] = ${json(snapshot.features)} as const;`,
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
  console.log(`[config-schema:generate] wrote: ${path}`);
  return true;
}

if (import.meta.main) {
  const snapshot = await loadSchemaSnapshot();
  const written = writeIfChanged(TS_OUT_PATH, renderTs(snapshot));
  console.log(written ? '[config-schema:generate] done' : '[config-schema:generate] up-to-date');
}
