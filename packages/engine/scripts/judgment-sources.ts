import { resolve } from 'node:path';

export const WORKSPACE_ROOT = resolve(import.meta.dir, '../../..');
const SKIPPED = /(^|\/)(node_modules|dist|test|tests|__tests__|testing|fixtures|e2e)\/|\.(?:d|test|spec)\.(?:[cm]?[jt]sx?)$/;

/** Production decisions include terminal/browser products and development scripts. */
export function judgmentSourceFiles(root: string = WORKSPACE_ROOT): string[] {
  return ['packages/engine', 'products'].flatMap((directory) =>
    [...new Bun.Glob('**/*.{ts,tsx,js,jsx,mjs,cjs}').scanSync({ cwd: resolve(root, directory) })]
      .filter((file) => !SKIPPED.test(file))
      .map((file) => `${directory}/${file}`),
  ).sort();
}
