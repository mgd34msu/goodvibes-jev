import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { CapabilityProbe } from './capability-types.ts';

/**
 * Executes capability probes. This is the ONLY place a capability check runs
 * anything, and every branch here reads.
 *
 * Nothing in this file sends, delivers, launches, spends, navigates, or writes.
 * A boot-time capability check must be able to tell the owner "yes, you can
 * send email" without sending one. Because probes arrive as descriptions
 * rather than functions (see CapabilityProbe), a registrant cannot smuggle an
 * effect past this boundary, adding a new kind of check means editing this
 * file deliberately.
 */

export interface ProbeContext {
  /** Tool names registered in this session. */
  readonly registeredToolNames: ReadonlySet<string>;
  /** MCP servers this session can see, with their live posture. */
  readonly mcpServers: readonly {
    readonly name: string;
    readonly connected: boolean;
    readonly trustMode: string;
    readonly schemaFreshness: string;
  }[];
  /** Qualified names of MCP tools currently listed by connected servers. */
  readonly mcpToolNames: ReadonlySet<string>;
  /** Operator method ids the daemon actually serves (not merely catalogs). */
  readonly servedOperatorMethodIds: ReadonlySet<string>;
  /**
   * Whether a configuration key holds a usable value. Takes a key and answers
   * yes or no, it never returns the value, so a probe result can be reported
   * to the model without leaking a password or a token.
   */
  readonly configValuePresent: (key: string) => boolean;
}

export interface ProbeResult {
  readonly satisfied: boolean;
  /** What was found, in plain language. Never contains file contents. */
  readonly detail: string;
}

const requireFromHere = createRequire(import.meta.url);

function fileReadable(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Reports on a credential file without ever revealing what is in it: whether
 * it parses and whether the expected keys are present, never their values.
 */
function inspectJsonFile(path: string, requiredKeys: readonly string[]): ProbeResult {
  if (!fileReadable(path)) {
    return { satisfied: false, detail: `no file at ${path}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { satisfied: false, detail: `${path} exists but is not readable JSON` };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { satisfied: false, detail: `${path} is not a JSON object` };
  }
  if (requiredKeys.length === 0) {
    return { satisfied: true, detail: `${path} is present and parses` };
  }
  const record = parsed as Record<string, unknown>;
  // A key may be nested one level down, which is how OAuth client files are shaped.
  const nested = Object.values(record).filter((value): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value));
  const missing = requiredKeys.filter((key) =>
    !Object.hasOwn(record, key) && !nested.some((entry) => Object.hasOwn(entry, key)));
  if (missing.length > 0) {
    return { satisfied: false, detail: `${path} is missing ${missing.join(', ')}` };
  }
  return { satisfied: true, detail: `${path} is present and carries ${requiredKeys.join(', ')}` };
}

export function runCapabilityProbe(probe: CapabilityProbe, context: ProbeContext): ProbeResult {
  switch (probe.kind) {
    case 'file-present':
      return fileReadable(probe.path)
        ? { satisfied: true, detail: `${probe.label} found at ${probe.path}` }
        : { satisfied: false, detail: `${probe.label} not found at ${probe.path}` };

    case 'any-file-present': {
      const found = probe.paths.find((path) => fileReadable(path));
      return found
        ? { satisfied: true, detail: `${probe.label} found at ${found}` }
        : { satisfied: false, detail: `${probe.label} not found in any of: ${probe.paths.join(', ')}` };
    }

    case 'any-of': {
      // First satisfied alternative wins, and its detail is what gets reported
      // so the answer names the source that actually applies.
      for (const alternative of probe.probes) {
        const result = runCapabilityProbe(alternative, context);
        if (result.satisfied) return result;
      }
      const reasons = probe.probes.map((alternative) => runCapabilityProbe(alternative, context).detail);
      return { satisfied: false, detail: `${probe.label} not available: ${reasons.join('; ')}` };
    }

    case 'json-file-readable':
      return inspectJsonFile(probe.path, probe.requiredKeys ?? []);

    case 'directory-present': {
      try {
        const present = existsSync(probe.path) && statSync(probe.path).isDirectory();
        return present
          ? { satisfied: true, detail: `${probe.label} found at ${probe.path}` }
          : { satisfied: false, detail: `${probe.label} not found at ${probe.path}` };
      } catch {
        return { satisfied: false, detail: `${probe.label} not found at ${probe.path}` };
      }
    }

    case 'model-tool-registered':
      return context.registeredToolNames.has(probe.toolName)
        ? { satisfied: true, detail: `the ${probe.toolName} tool is registered` }
        : { satisfied: false, detail: `no ${probe.toolName} tool is registered in this session` };

    case 'mcp-server-connected': {
      const server = context.mcpServers.find((entry) => entry.name === probe.serverName);
      if (!server) return { satisfied: false, detail: `no MCP server named ${probe.serverName} is configured` };
      if (!server.connected) return { satisfied: false, detail: `the MCP server ${probe.serverName} is not connected` };
      if (server.trustMode === 'blocked') return { satisfied: false, detail: `the MCP server ${probe.serverName} is set to blocked` };
      if (server.schemaFreshness === 'quarantined') return { satisfied: false, detail: `the MCP server ${probe.serverName} is quarantined` };
      return { satisfied: true, detail: `the MCP server ${probe.serverName} is connected and usable` };
    }

    case 'mcp-tool-available':
      return context.mcpToolNames.has(probe.qualifiedName)
        ? { satisfied: true, detail: `${probe.qualifiedName} is listed by a connected server` }
        : { satisfied: false, detail: `${probe.qualifiedName} is not offered by any connected MCP server` };

    case 'operator-method-served':
      return context.servedOperatorMethodIds.has(probe.methodId)
        ? { satisfied: true, detail: `the daemon serves ${probe.methodId}` }
        : { satisfied: false, detail: `${probe.methodId} is cataloged but no daemon route serves it` };

    case 'config-value-present':
      return context.configValuePresent(probe.key)
        ? { satisfied: true, detail: `${probe.label} is configured (${probe.key})` }
        : { satisfied: false, detail: `${probe.label} is not configured (${probe.key} is unset)` };

    case 'module-resolvable': {
      try {
        requireFromHere.resolve(probe.specifier);
        return { satisfied: true, detail: `${probe.label} is installed` };
      } catch {
        // Not resolvable as a module. Inside a compiled binary that is the
        // normal case rather than an answer, so the declared on-disk locations
        // decide it, the same ones the runtime loads the package from.
      }
      // The completeness rule is the registrant's, so it can be the SAME rule
      // the runtime resolver applies. A directory that satisfies a weaker test
      // would be reported as present and then rejected on first use.
      const requiredFiles = probe.requiredFiles ?? ['package.json', 'index.js'];
      for (const directory of probe.searchDirectories ?? []) {
        if (requiredFiles.every((file) => fileReadable(join(directory, file)))) {
          return { satisfied: true, detail: `${probe.label} is present at ${directory}` };
        }
      }
      return {
        satisfied: false,
        detail: (probe.searchDirectories ?? []).length > 0
          ? `${probe.label} (${probe.specifier}) is not installed and is not present in any of: ${(probe.searchDirectories ?? []).join(', ')}`
          : `${probe.label} (${probe.specifier}) is not installed`,
      };
    }

    default: {
      // Exhaustive: a new probe kind must be handled here on purpose.
      const unreachable: never = probe;
      return { satisfied: false, detail: `unknown probe ${JSON.stringify(unreachable)}` };
    }
  }
}

export function emptyProbeContext(): ProbeContext {
  return {
    registeredToolNames: new Set(),
    mcpServers: [],
    mcpToolNames: new Set(),
    servedOperatorMethodIds: new Set(),
    configValuePresent: () => false,
  };
}
