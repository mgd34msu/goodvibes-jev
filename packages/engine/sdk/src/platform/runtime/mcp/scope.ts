/** Apply configured MCP scopes to structured path/URL arguments without remote classification. */
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpReadingOwner } from './permissions.js';

/**
 * The path as the file system will resolve it: `..` and `.` segments removed
 * and symlinks followed for the part of the path that exists, so a request
 * for `/allowed/../elsewhere` or a link out of an allowed directory is judged
 * by where it lands, not by how it is spelled.
 */
function realPathOf(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(existing), ...rest);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return absolute;
      rest.unshift(basename(existing));
      existing = parent;
    }
  }
}

/** Extract structured addresses locally; owner scopes remain real-path and host checks. */
export async function readScopedValues(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  scopes: { readonly paths: boolean; readonly hosts: boolean },
  owner: McpReadingOwner = {},
): Promise<{ readonly paths: readonly string[]; readonly hosts: readonly string[]; readonly uncertain: boolean; readonly judgmentDecisionIds: readonly string[] }> {
  owner.signal?.throwIfAborted();
  const paths: string[] = [];
  const hosts: string[] = [];
  const pathKeys = new Set(['path', 'paths', 'file', 'files', 'filename', 'directory', 'directories', 'cwd', 'root']);
  const hostKeys = new Set(['host', 'hosts', 'hostname', 'hostnames', 'url', 'urls', 'uri', 'endpoint', 'href']);
  const visit = (value: unknown, key: string): void => {
    if (Array.isArray(value)) { for (const entry of value) visit(entry, key); return; }
    if (value && typeof value === 'object') { for (const [name, entry] of Object.entries(value)) visit(entry, name.toLowerCase()); return; }
    if (typeof value !== 'string' || !value.trim()) return;
    if (scopes.paths && (pathKeys.has(key) || value.startsWith('file:') || value.startsWith('/') || value.startsWith('./') || value.startsWith('../'))) paths.push(value);
    if (scopes.hosts && (hostKeys.has(key) || value.startsWith('https://') || value.startsWith('http://')) && !value.startsWith('file:')) hosts.push(value);
  };
  visit(args, '');
  return { paths, hosts, uncertain: false, judgmentDecisionIds: [] };
}

/** A path value as a filesystem path: a `file:` URL is converted by the URL grammar. */
const asFilesystemPath = (value: string): string => (value.startsWith('file:') ? fileURLToPath(value) : value);

/**
 * Whether every path the call touches lies inside one of the owner's allowed
 * directories. Containment is a path-component comparison of real paths, so
 * `/allowed-2` is not inside `/allowed`.
 */
export function pathsInScope(allowedPaths: readonly string[], paths: readonly string[]): boolean {
  if (allowedPaths.length === 0) return true;
  const roots = allowedPaths.map(realPathOf);
  return paths.every((value) => {
    let target: string;
    try {
      target = realPathOf(asFilesystemPath(value));
    } catch {
      return false;
    }
    return roots.some((root) => target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`));
  });
}

/**
 * The host a destination value names, by the URL grammar: a value with a
 * scheme is parsed as a URL; a bare `host`, `host:port` or IP is parsed as the
 * authority of one. Undefined when the value is not a parseable authority.
 */
function hostOf(value: string): string | undefined {
  try {
    return (value.includes('://') ? new URL(value) : new URL(`http://${value}`)).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Whether every destination the call reaches is one of the owner's allowed hosts or their subdomains. */
export function hostsInScope(allowedHosts: readonly string[], hosts: readonly string[]): boolean {
  if (allowedHosts.length === 0) return true;
  return hosts.every((value) => {
    const host = hostOf(value);
    return host !== undefined && allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  });
}
