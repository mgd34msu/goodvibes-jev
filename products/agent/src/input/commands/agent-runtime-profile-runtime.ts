import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  clearAgentRuntimeProfileSelection,
  createAgentRuntimeProfileFromDiscovered,
  createAgentRuntimeProfileTemplateFromDiscovered,
  createAgentRuntimeProfile,
  deleteAgentRuntimeProfile,
  exportAgentRuntimeProfileTemplate,
  getAgentRuntimeProfileTemplateFile,
  importAgentRuntimeProfileTemplate,
  listAgentRuntimeProfiles,
  listAgentRuntimeProfileTemplates,
  readAgentRuntimeProfileSelection,
  resolveAgentRuntimeProfileHome,
  setAgentRuntimeProfileSelection,
  type AgentRuntimeProfileInfo,
  type AgentRuntimeProfileTemplateSummary,
} from '../../agent/runtime-profile.ts';
import { formatAgentRecordSource } from '../../agent/record-labels.ts';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireYesFlag, stripYesFlag } from './confirmation.ts';
import { requireShellPaths } from './runtime-services.ts';

function parseFlag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

function parseCsvFlag(args: readonly string[], name: string): readonly string[] | undefined {
  const raw = parseFlag(args, name);
  if (!raw) return undefined;
  return raw.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function profileLine(profile: AgentRuntimeProfileInfo): string {
  const created = profile.createdAt ? `  created ${profile.createdAt}` : '';
  const starter = profile.starterTemplateId ? `  starter=${profile.starterTemplateId}` : '';
  return `  ${profile.id}  home ${profile.homeDirectory}${created}${starter}`;
}

function templateLine(template: AgentRuntimeProfileTemplateSummary): string {
  const origin = template.source === 'local' ? `local ${template.path ?? ''}`.trim() : formatAgentRecordSource(template.source).toLowerCase();
  return [
    `  ${template.id}  [${origin}]`,
    `    ${template.name} - ${template.description}`,
    `    persona ${template.personaName}`,
    `    skills ${template.skillNames.join(', ')}`,
    `    routines ${template.routineNames.join(', ')}`,
    template.vibeIncluded ? '    vibe included' : '',
  ].filter(Boolean).join('\n');
}

function renderProfiles(homeDirectory: string): string {
  const profiles = listAgentRuntimeProfiles(homeDirectory);
  const selected = readAgentRuntimeProfileSelection(homeDirectory);
  const defaultLine = selected ? `  default: ${selected.id}${selected.exists ? '' : ' (missing)'}` : '  default: (base Agent home)';
  if (profiles.length === 0) {
    return [
      'Agent Profiles',
      defaultLine,
      '  No isolated Agent profiles yet.',
      '  Create one with /agent-profile create <name> --template <id> --yes.',
    ].join('\n');
  }
  return ['Agent Profiles', defaultLine, ...profiles.map(profileLine)].join('\n');
}

function renderProfileDetail(homeDirectory: string, name: string): string {
  const profile = resolveAgentRuntimeProfileHome(homeDirectory, name);
  const info = listAgentRuntimeProfiles(homeDirectory).find((entry) => entry.id === profile.id) ?? { ...profile, createdAt: null };
  const starter = info.starterTemplateId ? [`  starter: ${info.starterTemplateId} (${info.starterTemplateName ?? info.starterTemplateId})`] : [];
  return [
    `Agent profile: ${profile.id}`,
    `  home ${profile.homeDirectory}`,
    ...starter,
    `  use goodvibes-agent --agent-profile ${profile.id}`,
  ].join('\n');
}

function renderTemplates(homeDirectory: string): string {
  const templates = listAgentRuntimeProfileTemplates(homeDirectory);
  return [
    `Agent Starter Templates (${templates.length})`,
    ...templates.map(templateLine),
    '',
    'Authoring flow:',
    '  /agent-profile template export research ./agent-starter.json --yes',
    '  edit the JSON file',
    '  /agent-profile template import ./agent-starter.json --yes',
    '  /agent-profile create <name> --template <imported-id> --yes',
    '  /agent-profile create-from-discovered <name> --yes',
  ].join('\n');
}

function renderGuide(homeDirectory: string): string {
  const templates = listAgentRuntimeProfileTemplates(homeDirectory);
  const localCount = templates.filter((template) => template.source === 'local').length;
  return [
    'Agent Starter Authoring Guide',
    `  built-in starters ${templates.length - localCount}`,
    `  local starters ${localCount}`,
    '',
    '1. Pick a base starter:',
    '   /agent-profile templates',
    '2. Export a starter JSON file:',
    '   /agent-profile template export research ./agent-starter.json --yes',
    '3. Edit id, name, description, persona, skills, routines, and optional vibe in that JSON file.',
    '4. Import it into this Agent home:',
    '   /agent-profile template import ./agent-starter.json --yes',
    '5. Create an Agent profile from the imported starter:',
    '   /agent-profile create <name> --template <imported-id> --yes',
    '',
    'This writes only Agent-local starter/profile state. It does not mutate connected GoodVibes host, default knowledge, or non-Agent knowledge segments.',
  ].join('\n');
}

function renderTemplatePreview(homeDirectory: string, templateId: string): string {
  const file = getAgentRuntimeProfileTemplateFile(templateId, homeDirectory);
  return [
    `Agent Starter Template ${file.template.id}`,
    `  name ${file.template.name}`,
    `  origin ${formatAgentRecordSource(file.template.source)}`,
    `  description ${file.template.description}`,
    `  persona ${file.template.persona.name}`,
    `  skills ${file.template.skills.map((skill) => skill.name).join(', ')}`,
    `  routines ${file.template.routines.map((routine) => routine.name).join(', ')}`,
    file.template.vibe ? '  vibe included' : '',
    '',
    'Export/edit/import to customize this starter:',
    `  /agent-profile template export ${file.template.id} ./agent-starter.json --include-vibe --yes`,
  ].join('\n');
}

export function registerAgentRuntimeProfileRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'agent-profile',
    aliases: ['runtime-profile', 'agent-profiles'],
    description: 'Manage isolated Agent profiles and starter templates',
    hidden: true,
    usage: '[list|show|default|use|templates|guide|template show|template export|template import|template from-discovered|create|create-from-discovered|delete]',
    async handler(args, ctx) {
      const shellPaths = requireShellPaths(ctx);
      const homeDirectory = shellPaths.homeDirectory;
      const parsed = stripYesFlag(args);
      const commandArgs = [...parsed.rest];
      const sub = (commandArgs[0] ?? 'list').toLowerCase();

      try {
        if (sub === 'list' || sub === 'profiles') {
          ctx.print(renderProfiles(homeDirectory));
          return;
        }

        if (sub === 'templates' || sub === 'starters') {
          ctx.print(renderTemplates(homeDirectory));
          return;
        }

        if (sub === 'show' || sub === 'path' || sub === 'home') {
          const name = commandArgs[1];
          if (!name) {
            ctx.print('Usage: /agent-profile show <name>');
            return;
          }
          ctx.print(renderProfileDetail(homeDirectory, name));
          return;
        }

        if (sub === 'default') {
          const target = commandArgs[1];
          if (target === 'clear' || target === 'none' || target === 'base') {
            if (!parsed.yes) {
              requireYesFlag(ctx, 'clear the default Agent profile', '/agent-profile default clear --yes');
              return;
            }
            clearAgentRuntimeProfileSelection(homeDirectory);
            ctx.print('Default Agent profile cleared. Next launch uses the base Agent home unless --agent-profile is provided.');
            return;
          }
          if (target) {
            if (!parsed.yes) {
              requireYesFlag(ctx, `set default Agent profile ${target}`, '/agent-profile default <name> --yes');
              return;
            }
            const selected = setAgentRuntimeProfileSelection(homeDirectory, target);
            ctx.print([
              `Default Agent profile selected: ${selected.id}`,
              `  home ${selected.homeDirectory}`,
              '  next launch: goodvibes-agent',
              '  explicit override goodvibes-agent --agent-profile <name>',
            ].join('\n'));
            return;
          }
          const selected = readAgentRuntimeProfileSelection(homeDirectory);
          ctx.print(selected
            ? [
              `Default Agent profile: ${selected.id}${selected.exists ? '' : ' (missing)'}`,
              `  home ${selected.homeDirectory}`,
              '  next launch: goodvibes-agent',
            ].join('\n')
            : 'No default Agent profile selected. Next launch uses the base Agent home.');
          return;
        }

        if (sub === 'use' || sub === 'select' || sub === 'switch') {
          const name = commandArgs[1];
          if (!name) {
            ctx.print('Usage: /agent-profile use <name> --yes');
            return;
          }
          if (!parsed.yes) {
            requireYesFlag(ctx, `set default Agent profile ${name}`, '/agent-profile use <name> --yes');
            return;
          }
          const selected = setAgentRuntimeProfileSelection(homeDirectory, name);
          ctx.print([
            `Default Agent profile selected: ${selected.id}`,
            `  home ${selected.homeDirectory}`,
            '  next launch: goodvibes-agent',
            '  explicit override goodvibes-agent --agent-profile <name>',
          ].join('\n'));
          return;
        }

        if (sub === 'guide' || sub === 'author') {
          ctx.print(renderGuide(homeDirectory));
          return;
        }

        if (sub === 'template' || sub === 'starter') {
          const mode = (commandArgs[1] ?? 'show').toLowerCase();
          if (mode === 'show' || mode === 'preview') {
            const templateId = commandArgs[2];
            if (!templateId) {
              ctx.print('Usage: /agent-profile template show <id>');
              return;
            }
            ctx.print(renderTemplatePreview(homeDirectory, templateId));
            return;
          }
          if (mode === 'export') {
            const templateId = commandArgs[2];
            const pathArg = commandArgs[3];
            if (!templateId || !pathArg) {
              ctx.print('Usage: /agent-profile template export <id> <path> [--include-vibe] --yes');
              return;
            }
            if (!parsed.yes) {
              requireYesFlag(ctx, `export Agent starter template ${templateId}`, '/agent-profile template export <id> <path> [--include-vibe] --yes');
              return;
            }
            const targetPath = shellPaths.resolveWorkspacePath(pathArg);
            mkdirSync(dirname(targetPath), { recursive: true });
            const template = exportAgentRuntimeProfileTemplate(homeDirectory, templateId, targetPath, {
              includeVibe: commandArgs.includes('--include-vibe'),
              shellPaths,
            });
            ctx.print([
              `Agent starter template exported: ${template.id}`,
              `  path ${template.path ?? targetPath}`,
              template.vibeIncluded ? '  vibe included' : '',
              '  edit it, then import it with /agent-profile template import <path> --yes',
            ].filter(Boolean).join('\n'));
            return;
          }
          if (mode === 'import') {
            const pathArg = commandArgs[2];
            if (!pathArg) {
              ctx.print('Usage: /agent-profile template import <path> --yes');
              return;
            }
            if (!parsed.yes) {
              requireYesFlag(ctx, 'import Agent starter template', '/agent-profile template import <path> --yes');
              return;
            }
            const sourcePath = shellPaths.resolveWorkspacePath(pathArg);
            const template = importAgentRuntimeProfileTemplate(homeDirectory, sourcePath);
            ctx.print(`Agent starter template imported: ${template.id}\n  origin ${formatAgentRecordSource(template.source).toLowerCase()}\n  use /agent-profile create <name> --template ${template.id} --yes`);
            return;
          }
          if (mode === 'from-discovered' || mode === 'import-discovered') {
            const templateId = commandArgs[2];
            if (!templateId) {
              ctx.print('Usage: /agent-profile template from-discovered <id> [--name <name>] [--description <summary>] [--persona <name>] [--skills all|name,name] [--routines all|name,name] [--include-vibe] [--replace] --yes');
              return;
            }
            if (!parsed.yes) {
              requireYesFlag(ctx, `create Agent starter template ${templateId} from discovered behavior`, '/agent-profile template from-discovered <id> --yes');
              return;
            }
            const template = await createAgentRuntimeProfileTemplateFromDiscovered(shellPaths, {
              id: templateId,
              name: parseFlag(commandArgs, '--name'),
              description: parseFlag(commandArgs, '--description'),
              persona: parseFlag(commandArgs, '--persona'),
              skills: parseCsvFlag(commandArgs, '--skills'),
              routines: parseCsvFlag(commandArgs, '--routines'),
              includeVibe: commandArgs.includes('--include-vibe'),
              replace: commandArgs.includes('--replace'),
            });
            ctx.print([
              `Agent starter template created from discovered behavior: ${template.id}`,
              `  persona ${template.personaName}`,
              `  skills ${template.skillNames.join(', ')}`,
              `  routines ${template.routineNames.join(', ')}`,
              template.vibeIncluded ? '  vibe included' : '',
              `  use /agent-profile create <name> --template ${template.id} --yes`,
            ].filter(Boolean).join('\n'));
            return;
          }
          ctx.print('Usage: /agent-profile template [show <id>|export <id> <path> [--include-vibe] --yes|import <path> --yes|from-discovered <id> --yes]');
          return;
        }

        if (sub === 'create') {
          const name = commandArgs[1];
          const templateId = parseFlag(commandArgs, '--template') ?? parseFlag(commandArgs, '--starter');
          if (!name) {
            ctx.print('Usage: /agent-profile create <name> [--template <id>] --yes');
            return;
          }
          if (!parsed.yes) {
            requireYesFlag(ctx, `create Agent profile ${name}`, '/agent-profile create <name> [--template <id>] --yes');
            return;
          }
          const profile = createAgentRuntimeProfile(homeDirectory, name, { templateId });
          ctx.print([
            `Agent profile created: ${profile.id}`,
            `  home ${profile.homeDirectory}`,
            profile.starterTemplateId ? `  starter: ${profile.starterTemplateId}` : '',
            profile.starterTemplateApplication?.vibePath ? `  vibe ${profile.starterTemplateApplication.vibePath}` : '',
            `  launch goodvibes-agent --agent-profile ${profile.id}`,
          ].filter(Boolean).join('\n'));
          return;
        }

        if (sub === 'create-from-discovered' || sub === 'create-discovered') {
          const profileName = commandArgs[1];
          if (!profileName) {
            ctx.print('Usage: /agent-profile create-from-discovered <name> [--template-id <id>] [--profile-name <display>] [--description <summary>] [--persona <name>] [--skills all|name,name] [--routines all|name,name] [--include-vibe] [--replace] --yes');
            return;
          }
          if (!parsed.yes) {
            requireYesFlag(ctx, `create Agent profile ${profileName} from discovered behavior`, '/agent-profile create-from-discovered <name> --yes');
            return;
          }
          const created = await createAgentRuntimeProfileFromDiscovered(shellPaths, {
            profileName,
            templateId: parseFlag(commandArgs, '--template-id') ?? parseFlag(commandArgs, '--starter-id'),
            name: parseFlag(commandArgs, '--profile-name') ?? parseFlag(commandArgs, '--name'),
            description: parseFlag(commandArgs, '--description'),
            persona: parseFlag(commandArgs, '--persona'),
            skills: parseCsvFlag(commandArgs, '--skills'),
            routines: parseCsvFlag(commandArgs, '--routines'),
            includeVibe: commandArgs.includes('--include-vibe'),
            replace: commandArgs.includes('--replace'),
          });
          ctx.print([
            `Agent profile created from discovered behavior: ${created.profile.id}`,
            `  home ${created.profile.homeDirectory}`,
            `  starter: ${created.template.id}`,
            `  persona ${created.template.personaName}`,
            `  skills ${created.template.skillNames.join(', ')}`,
            `  routines ${created.template.routineNames.join(', ')}`,
            created.template.vibeIncluded ? '  vibe included' : '',
            `  launch goodvibes-agent --agent-profile ${created.profile.id}`,
          ].filter(Boolean).join('\n'));
          return;
        }

        if (sub === 'delete') {
          const name = commandArgs[1];
          if (!name) {
            ctx.print('Usage: /agent-profile delete <name> --yes');
            return;
          }
          if (!parsed.yes) {
            requireYesFlag(ctx, `delete Agent profile ${name}`, '/agent-profile delete <name> --yes');
            return;
          }
          ctx.print(deleteAgentRuntimeProfile(homeDirectory, name) ? `Agent profile deleted: ${name}` : `Agent profile not found ${name}`);
          return;
        }

        ctx.print('Usage: /agent-profile [list|show <name>|default [<name>|clear] --yes|use <name> --yes|templates|guide|template show <id>|template export <id> <path> [--include-vibe] --yes|template import <path> --yes|create <name> [--template <id>] --yes|create-from-discovered <name> [--include-vibe] --yes|delete <name> --yes]');
      } catch (error) {
        ctx.print([
          'Error',
          `  message ${error instanceof Error ? error.message : String(error)}`,
        ].join('\n'));
      }
    },
  });
}
