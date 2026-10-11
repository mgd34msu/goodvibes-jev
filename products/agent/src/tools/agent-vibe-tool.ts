import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { assertCurrentToolExecution, type ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { dirname } from 'node:path';
import { captureCatalogData, captureCatalogMethods } from './agent-harness-catalog-ranking.ts';
import { agentLocalStateWrite, assertAgentLocalStateCurrent, createAgentLocalStateInputProjector } from './agent-local-state-admission.ts';
import { AgentPersonaRegistry, personaStorePath } from '../agent/persona-registry.ts';
import {
  discoverVibeFiles,
  initVibeFile,
  loadVibeImportSource,
  resolveVibePathReference,
  type AgentVibeFile,
} from '../agent/vibe-file.ts';
import type { CommandContext } from '../input/command-registry.ts';
import { requireShellPaths } from '../input/commands/runtime-services.ts';
import { previewHarnessText } from './agent-harness-text.ts';

type AgentVibeAction = 'status' | 'show' | 'init' | 'import_persona';

interface AgentVibeToolArgs {
  readonly action?: unknown;
  readonly mode?: unknown;
  readonly scope?: unknown;
  readonly reference?: unknown;
  readonly path?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly name?: unknown;
  readonly description?: unknown;
  readonly force?: unknown;
  readonly review?: unknown;
  readonly use?: unknown;
  readonly includeParameters?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

function output(value: unknown): { readonly success: true; readonly output: string } {
  return {
    success: true,
    output: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  };
}

function error(message: string): { readonly success: false; readonly error: string } {
  return { success: false, error: message };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readBoolean(value: unknown): boolean {
  return value === true || (typeof value === 'string' && ['true', 'yes', 'use', 'review', 'apply', 'run'].includes(value.trim().toLowerCase()));
}

function normalizeVibeAction(value: unknown): AgentVibeAction | null {
  const action = readString(value).toLowerCase().replace(/-/g, '_');
  if (!action) return null;
  if (action === 'status' || action === 'summary' || action === 'list' || action === 'inspect') return 'status';
  if (action === 'show' || action === 'file' || action === 'source' || action === 'read') return 'show';
  if (action === 'init' || action === 'create' || action === 'new') return 'init';
  if (action === 'import' || action === 'import_persona' || action === 'persona') return 'import_persona';
  return null;
}

function readAction(args: AgentVibeToolArgs): AgentVibeAction {
  return normalizeVibeAction(args.action) ?? normalizeVibeAction(args.mode) ?? 'status';
}

function readReference(args: AgentVibeToolArgs): string {
  return readString(args.path)
    || readString(args.reference)
    || readString(args.target)
    || readString(args.query)
    || readString(args.scope)
    || 'project';
}

function readScope(args: AgentVibeToolArgs): 'project' | 'global' {
  return readString(args.scope).toLowerCase() === 'global' ? 'global' : 'project';
}

function describeVibeFile(file: AgentVibeFile): Record<string, unknown> {
  return {
    scope: file.scope,
    path: file.path,
    truncated: file.truncated,
    name: file.frontmatter.name?.trim() || undefined,
    description: file.frontmatter.description?.trim() || file.frontmatter.summary?.trim() || undefined,
    bodyCharacters: file.body.length,
  };
}

export function createAgentVibeTool(commandContext: CommandContext): Tool {
  return {
    definition: {
      name: 'vibe',
      description: 'Inspect and manage VIBE.md personality files.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'show', 'init', 'import_persona'],
            description: 'Read status/show; confirm init or import_persona.',
          },
          mode: { type: 'string', description: 'Alias for action.' },
          scope: { type: 'string', enum: ['project', 'global'], description: 'VIBE.md scope for init/show/import.' },
          reference: { type: 'string', description: 'project, global, or path reference.' },
          path: { type: 'string', description: 'Path reference for show/import.' },
          target: { type: 'string', description: 'Alias for reference.' },
          query: { type: 'string', description: 'Alias for reference.' },
          name: { type: 'string', description: 'Persona name when importing.' },
          description: { type: 'string', description: 'Persona description when importing.' },
          force: { type: 'boolean', description: 'Replace existing VIBE.md on admitted init.' },
          review: { type: 'boolean', description: 'Mark imported persona reviewed.' },
          use: { type: 'boolean', description: 'Set imported persona active.' },
          includeParameters: { type: 'boolean', description: 'Include searched paths and route details.' },
          confirm: { type: 'boolean', description: 'Optional provenance; never grants write authority.' },
          explicitUserRequest: { type: 'string', description: 'Optional request provenance; never grants write authority.' },
        },
        additionalProperties: false,
      },
      sideEffects: ['state'],
      concurrency: 'serial',
    },
    execute: async (rawArgs, options) => {
      try {
        const args = captureCatalogData(rawArgs);
        options?.signal?.throwIfAborted(); assertCurrentToolExecution(rawArgs, options);
        const shellPaths = requireShellPaths(commandContext);
        const action = readAction(args);
        if (action === 'status') {
          const snapshot = discoverVibeFiles(shellPaths);
          assertAgentLocalStateCurrent(rawArgs, options);
          return output({
            status: snapshot.blocked.length > 0 || snapshot.files.some((file) => file.truncated)
              ? 'check'
              : snapshot.files.length > 0
                ? 'ready'
                : 'recommended',
            action: 'vibe_status',
            applied: snapshot.files.length,
            blocked: snapshot.blocked.length,
            truncated: snapshot.files.filter((file) => file.truncated).length,
            projectInitPath: snapshot.projectInitPath,
            globalInitPath: snapshot.globalInitPath,
            files: snapshot.files.map(describeVibeFile),
            blockedFiles: snapshot.blocked.map((file) => ({
              scope: file.scope,
              path: file.path,
              reason: previewHarnessText(file.reason, 220),
            })),
            routes: {
              showProject: 'vibe action:"show" scope:"project"',
              showGlobal: 'vibe action:"show" scope:"global"',
              initProject: 'vibe action:"init" scope:"project"',
              importProjectPersona: 'vibe action:"import_persona" scope:"project" review:true use:true',
              promptContext: 'context action:"prompt" includeParameters:true',
            },
            ...(readBoolean(args.includeParameters) ? { searchedPaths: snapshot.searchedPaths } : {}),
          });
        }

        if (action === 'show') {
          const reference = readReference(args);
          const source = loadVibeImportSource(shellPaths, reference);
          assertAgentLocalStateCurrent(rawArgs, options);
          return output({
            status: 'ready',
            action: 'vibe_show',
            source: source.scope,
            path: source.path,
            name: source.name,
            description: source.description,
            bodyCharacters: source.body.length,
            body: source.body,
            policy: {
              boundary: 'Loaded only after VIBE.md secret-looking content scan; blocked files are not returned.',
            },
          });
        }

        if (action === 'init') {
          const scope = readScope(args);
          const effects = agentLocalStateWrite(rawArgs, options);
          const result = initVibeFile(shellPaths, { scope, force: readBoolean(args.force), ...effects });
          return output({
            status: result.created ? 'created' : 'already_exists',
            action: 'vibe_init',
            scope,
            path: result.path,
            created: result.created,
            next: result.created ? 'Edit this VIBE.md with the personality instructions the user wants.' : 'Use force:true only when the user asks to replace the existing file.',
            policy: {
              admission: 'act',
              explicitUserRequest: readString(args.explicitUserRequest),
              boundary: 'Wrote only the scoped VIBE.md starter file.',
            },
          });
        }

        if (action === 'import_persona') {
          const reference = readReference(args);
          const source = loadVibeImportSource(shellPaths, reference);
          const name = readString(args.name) || source.name;
          const description = readString(args.description) || source.description;
          const effects = agentLocalStateWrite(rawArgs, options);
          const personaRegistry = AgentPersonaRegistry.fromShellPaths(shellPaths, effects);
          const created = personaRegistry.create({
            name,
            description,
            body: source.body,
            tags: ['vibe', source.scope],
            triggers: ['vibe'],
            source: 'imported',
            provenance: `Imported VIBE.md (${source.scope}): ${source.path}`,
          });
          const reviewed = readBoolean(args.review) ? personaRegistry.markReviewed(created.id) : created;
          const active = readBoolean(args.use) ? personaRegistry.setActive(created.id) : null;
          return output({
            status: 'imported',
            action: 'vibe_import_persona',
            source: source.scope,
            path: source.path,
            persona: {
              id: reviewed.id,
              name: reviewed.name,
              description: reviewed.description,
              reviewState: reviewed.reviewState,
              active: active?.id === reviewed.id,
            },
            routes: {
              inspectPersona: `agent_local_registry domain:"persona" action:"get" id:"${reviewed.id}"`,
              promptContext: 'context action:"prompt" includeParameters:true',
            },
            policy: {
              admission: 'act',
              explicitUserRequest: readString(args.explicitUserRequest),
              boundary: 'Created only one Agent-local persona from secret-scanned VIBE.md content; no default Knowledge write.',
            },
          });
        }

        return error('Unknown VIBE.md action. Use action:"status" to inspect personality files.');
      } catch (caught) {
        return error(caught instanceof Error ? caught.message : String(caught));
      }
    },
  };
}

export function registerAgentVibeTool(registry: ToolRegistry, commandContext: CommandContext): void {
  if (!registry.has('vibe')) registry.register(createAgentVibeTool(commandContext), { inputProjection: createAgentLocalStateInputProjector(args => {
    const workspace = commandContext.workspace;
    const shellPaths = requireShellPaths(commandContext);
    const contextCurrent = captureCatalogMethods(commandContext, ['workspace']);
    const workspaceCurrent = captureCatalogMethods(workspace, ['shellPaths']);
    const pathsCurrent = captureCatalogMethods(shellPaths, ['homeDirectory', 'workingDirectory', 'resolveUserPath', 'expandHomePath', 'resolveWorkspacePath']);
    const personaCurrent = captureCatalogMethods(AgentPersonaRegistry.prototype, Object.getOwnPropertyNames(AgentPersonaRegistry.prototype));
    const factoryCurrent = captureCatalogMethods(AgentPersonaRegistry, ['fromShellPaths']);
    const action = readAction(args);
    const assertDescriptors = () => { contextCurrent(); workspaceCurrent(); pathsCurrent(); personaCurrent(); factoryCurrent(); };
    assertDescriptors();
    if (action === 'init') {
      const root = readScope(args) === 'global' ? shellPaths.homeDirectory : shellPaths.workingDirectory;
      return { targets: [{ root, path: resolveVibePathReference(shellPaths, readScope(args)), access: 'write' }], assertDescriptors };
    }
    if (action === 'import_persona') {
      const path = resolveVibePathReference(shellPaths, readReference(args));
      return { targets: [{ root: dirname(path), path, access: 'read' },
        { root: shellPaths.homeDirectory, path: personaStorePath(shellPaths), access: 'write' }], assertDescriptors };
    }
    return { targets: [], assertDescriptors };
  }, args => ['status', 'show'].includes(readAction(args))) });
}
