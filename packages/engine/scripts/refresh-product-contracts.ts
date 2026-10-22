/** Refresh each present product's contract projection after engine generation. */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const generators = ['products/webui/scripts/generate-contract-inspection-schema.ts'];
for (const generator of generators) {
  const path = resolve(root, generator);
  if (existsSync(path)) execFileSync(process.execPath, [path], { cwd: root, stdio: 'inherit' });
}
