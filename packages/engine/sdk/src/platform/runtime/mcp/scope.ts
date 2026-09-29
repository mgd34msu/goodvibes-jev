/**
 * The owner's path and host scope for an MCP server's calls: which argument
 * values a call touches as filesystem paths or reaches as network
 * destinations (a Jev reading per argument, `engine.gate.mcp-scope-arg`), and
 * whether each lies inside the owner's allowed paths and hosts (code: real-path
 * containment and the URL grammar's host).
 */
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapLimit, type YesNoReading } from '@goodvibes-jev/judgment';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { mcpScopeArg } from '../../gate/batteries/mcp-scope-arg.js';

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

/** Arguments read at once when a call's scope is read. */
const SCOPE_READ_CONCURRENCY = 8;

/** The string values a call carries: top-level strings and the strings in top-level arrays. */
function stringArguments(args: Record<string, unknown>): Array<{ readonly argument: string; readonly value: string }> {
  return Object.entries(args).flatMap(([argument, value]) => {
    if (typeof value === 'string') return value.trim() ? [{ argument, value }] : [];
    if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '').map((entry) => ({ argument, value: entry }));
    return [];
  });
}

/**
 * The argument values a call touches as filesystem paths and reaches as
 * network destinations, read by Jev per argument (`engine.gate.mcp-scope-arg`)
 * and asked only for the scopes the owner set. An uncertain reading counts as
 * a yes, so a value that might be a path or destination is held to the scope.
 */
export async function readScopedValues(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  scopes: { readonly paths: boolean; readonly hosts: boolean },
): Promise<{ readonly paths: readonly string[]; readonly hosts: readonly string[] }> {
  const only = [...(scopes.paths ? (['names_path'] as const) : []), ...(scopes.hosts ? (['names_host'] as const) : [])];
  if (only.length === 0) return { paths: [], hosts: [] };
  const site = 'engine.mcp.scope';
  const port = judgmentPort(site);
  const entries = stringArguments(args);
  const runs = await mapLimit(entries, SCOPE_READ_CONCURRENCY, (entry) =>
    mcpScopeArg.run(port, { server: serverName, tool: toolName, argument: entry.argument, value: entry.value }, { site, only }));
  const paths: string[] = [];
  const hosts: string[] = [];
  runs.forEach((run, index) => {
    const { value } = entries[index]!;
    const readings = run.readings as Partial<Record<'names_path' | 'names_host', YesNoReading>>;
    const isPath = readings.names_path !== undefined && readings.names_path.verdict !== 'no';
    const isHost = readings.names_host !== undefined && readings.names_host.verdict !== 'no';
    if (isPath) paths.push(value);
    if (isHost) hosts.push(value);
    run.recordAction(`${isPath ? 'path' : ''}${isPath && isHost ? '+' : ''}${isHost ? 'host' : ''}` || 'neither');
  });
  return { paths, hosts };
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
