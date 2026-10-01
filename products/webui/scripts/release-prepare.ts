#!/usr/bin/env bun
/** Prepare local WebUI assets. Versioning, installation, tagging and publishing belong to the monorepo. */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const GENERATORS = [
  'scripts/generate-config-schema.ts',
  'scripts/generate-config-ownership.ts',
  'scripts/generate-presentation-tokens.ts',
] as const;

/** Keep icon/manifest URLs in step with this product's declared version. */
export function rewriteCacheBustText(html: string, version: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('Invalid WebUI version');
  const pattern = /\?v=[^"'&\s]+/g;
  if (!pattern.test(html)) throw new Error('index.html has no ?v= cache-bust values');
  return html.replace(pattern, `?v=${version}`);
}

if (import.meta.main) {
  if (process.argv.slice(2).some((arg) => arg !== '--no-bump')) {
    throw new Error('WebUI release preparation regenerates assets only; change versions through the monorepo release process.');
  }
  const root = resolve(import.meta.dir, '..');
  for (const generator of GENERATORS) {
    const result = spawnSync(process.execPath, [generator], { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`${generator} failed (${String(result.status)})`);
  }
  const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string };
  const htmlPath = resolve(root, 'index.html');
  const before = readFileSync(htmlPath, 'utf8');
  const after = rewriteCacheBustText(before, version);
  if (after !== before) writeFileSync(htmlPath, after);
}
