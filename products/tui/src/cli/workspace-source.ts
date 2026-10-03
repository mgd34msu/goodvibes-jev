import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

function manifest(path: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

/** Recognize this private source workspace, not an arbitrary private installed package. */
export function isPrivateWorkspaceSource(directory: string): boolean {
  const product = resolve(directory);
  if (basename(product) !== 'tui' || basename(dirname(product)) !== 'products') return false;
  const pkg = manifest(join(product, 'package.json'));
  const dependencies = pkg?.dependencies;
  if (pkg?.name !== '@goodvibes-jev/tui' || pkg.private !== true
    || dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)
    || (dependencies as Record<string, unknown>)['@goodvibes-jev/engine'] !== 'workspace:*') return false;
  const root = dirname(dirname(product));
  const workspace = manifest(join(root, 'package.json'));
  if (workspace?.private !== true || !Array.isArray(workspace.workspaces)
    || !(workspace.workspaces.includes('products/*') || workspace.workspaces.includes('products/tui'))
    || !(workspace.workspaces.includes('packages/*') || workspace.workspaces.includes('packages/engine')))
    return false;
  if (!existsSync(join(root, '.git')) && !existsSync(join(root, 'bun.lock'))) return false;
  return manifest(join(root, 'packages', 'engine', 'package.json'))?.name === '@goodvibes-jev/engine';
}
