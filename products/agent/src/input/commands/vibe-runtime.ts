import { AgentPersonaRegistry } from '../../agent/persona-registry.ts';
import {
  discoverVibeFiles,
  formatVibeStatus,
  initVibeFile,
  loadVibeImportSource,
  resolveVibePathReference,
} from '../../agent/vibe-file.ts';
import {
  formatVibeConfirmationRouteLines,
  vibeImportPersonaConfirmationRoutes,
  vibeInitConfirmationRoutes,
} from '../../agent/vibe-confirmation-routes.ts';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { parseAgentLocalLibraryArgs } from './agent-local-library-args.ts';
import { requireShellPaths } from './runtime-services.ts';

const VIBE_VALUE_FLAGS = ['name', 'description'] as const;

function printError(ctx: CommandContext, error: unknown): void {
  ctx.print([
    'Error',
    `  message ${error instanceof Error ? error.message : String(error)}`,
  ].join('\n'));
}

function usage(): string {
  return [
    'Usage: /vibe [status|init|show|import-persona]',
    '  /vibe',
    '  /vibe init [--global] [--force] --yes',
    '  /vibe show [project|global|path]',
    '  /vibe import-persona [project|global|path] [--name <name>] [--description <summary>] [--review] [--use] --yes',
  ].join('\n');
}

export function registerVibeRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'vibe',
    aliases: ['vibes'],
    description: 'Inspect, create, and import VIBE.md personality files',
    hidden: true,
    usage: '[status|init|show|import-persona]',
    async handler(args, ctx) {
      const sub = (args[0] ?? 'status').toLowerCase();
      const shellPaths = requireShellPaths(ctx);
      try {
        if (sub === 'status' || sub === 'list' || sub === 'open') {
          ctx.print(formatVibeStatus(discoverVibeFiles(shellPaths)));
          return;
        }

        if (sub === 'init') {
          const parsed = parseAgentLocalLibraryArgs(args.slice(1), { valueFlags: VIBE_VALUE_FLAGS });
          const scope = parsed.flags.has('global') ? 'global' : 'project';
          const previewPath = scope === 'global'
            ? resolveVibePathReference(shellPaths, 'global')
            : resolveVibePathReference(shellPaths, 'project');
          if (!parsed.yes) {
            ctx.print([
              'VIBE.md init preview',
              `  scope ${scope}`,
              `  path ${previewPath}`,
              ...formatVibeConfirmationRouteLines(vibeInitConfirmationRoutes(scope, parsed.flags.has('force'))),
            ].join('\n'));
            return;
          }
          const result = initVibeFile(shellPaths, { scope, force: parsed.flags.has('force') });
          ctx.print(result.created
            ? `Created ${scope} VIBE.md\n  path ${result.path}`
            : `VIBE.md already exists\n  path ${result.path}\n  next rerun with --force --yes to replace it`);
          return;
        }

        if (sub === 'show') {
          const reference = args.slice(1).join(' ').trim() || 'project';
          const source = loadVibeImportSource(shellPaths, reference);
          ctx.print([
            `${source.scope === 'global' ? 'Global' : 'Project'} VIBE.md`,
            `  path ${source.path}`,
            `  name ${source.name}`,
            `  description ${source.description}`,
            '',
            source.body,
          ].join('\n'));
          return;
        }

        if (sub === 'import-persona' || sub === 'import') {
          const parsed = parseAgentLocalLibraryArgs(args.slice(1), { valueFlags: VIBE_VALUE_FLAGS });
          const reference = parsed.rest.join(' ').trim() || 'project';
          const source = loadVibeImportSource(shellPaths, reference);
          const name = parsed.flags.get('name')?.trim() || source.name;
          const description = parsed.flags.get('description')?.trim() || source.description;
          if (!parsed.yes) {
            ctx.print([
              'VIBE.md persona import preview',
              `  source ${source.scope}`,
              `  path ${source.path}`,
              `  name ${name}`,
              `  description ${description}`,
              `  body characters ${source.body.length}`,
              ...formatVibeConfirmationRouteLines(vibeImportPersonaConfirmationRoutes({
                reference,
                name,
                description,
                review: parsed.flags.has('review'),
                use: parsed.flags.has('use'),
              })),
            ].join('\n'));
            return;
          }
          const personaRegistry = AgentPersonaRegistry.fromShellPaths(shellPaths);
          const persona = personaRegistry.create({
            name,
            description,
            body: source.body,
            tags: ['vibe', source.scope],
            triggers: ['vibe'],
            source: 'imported',
            provenance: `Imported VIBE.md (${source.scope}): ${source.path}`,
          });
          if (parsed.flags.has('review')) personaRegistry.markReviewed(persona.id);
          if (parsed.flags.has('use')) personaRegistry.setActive(persona.id);
          ctx.print([
            `Imported VIBE.md persona ${persona.id}: ${persona.name}`,
            `  source ${source.scope}`,
            `  path ${source.path}`,
            `  reviewed ${parsed.flags.has('review') ? 'yes' : 'no'}`,
            `  active ${parsed.flags.has('use') ? 'yes' : 'no'}`,
          ].join('\n'));
          return;
        }

        ctx.print(usage());
      } catch (error) {
        printError(ctx, error);
      }
    },
  });
}
