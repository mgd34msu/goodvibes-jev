import {
  createAgentRuntimeProfile,
  createAgentRuntimeProfileFromDiscovered,
  createAgentRuntimeProfileTemplateFromDiscovered,
  clearAgentRuntimeProfileSelection,
  deleteAgentRuntimeProfile,
  exportAgentRuntimeProfileTemplate,
  importAgentRuntimeProfileTemplate,
  isAgentRuntimeProfileTemplateId,
  listAgentRuntimeProfiles,
  listAgentRuntimeProfileTemplates,
  readAgentRuntimeProfileSelection,
  resolveAgentRuntimeProfileHome,
  setAgentRuntimeProfileSelection,
  type AgentRuntimeProfileTemplateId,
  type AgentRuntimeProfileCommandResult,
  type AgentRuntimeProfileInfo,
} from '../agent/runtime-profile.ts';
import { formatAgentRecordSource } from '../agent/record-labels.ts';
import type { CliCommandOutput, GoodVibesCliParseResult } from './types.ts';
import { appendTemporalLabel } from './temporal-label.ts';

interface ProfilesCommandRuntime {
  readonly cli: GoodVibesCliParseResult;
  readonly homeDirectory: string;
  readonly workingDirectory: string;
}

function hasYes(args: readonly string[]): boolean {
  return args.includes('--yes');
}

function commandValues(args: readonly string[]): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith('--')) values.push(token);
  }
  return values;
}

function flagValue(args: readonly string[], names: readonly string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    for (const name of names) {
      if (token === name) {
        const next = args[index + 1];
        return next && !next.startsWith('--') ? next : null;
      }
      if (token.startsWith(`${name}=`)) return token.slice(name.length + 1);
    }
  }
  return null;
}

function parseTemplate(args: readonly string[]): AgentRuntimeProfileTemplateId | undefined {
  const raw = flagValue(args, ['--template', '--starter']);
  if (!raw || raw === 'blank') return undefined;
  const normalized = raw.trim().toLowerCase().replace(/_/g, '-');
  if (isAgentRuntimeProfileTemplateId(normalized)) return normalized;
  throw new Error(`Unknown Agent starter profile template ${raw}. Use profiles templates to list starters.`);
}

function parseCsvFlag(args: readonly string[], names: readonly string[]): readonly string[] | undefined {
  const raw = flagValue(args, names);
  if (!raw) return undefined;
  return raw.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function profileLine(profile: AgentRuntimeProfileInfo): string {
  const created = profile.createdAt ? ` created ${appendTemporalLabel(profile.createdAt, profile.createdAt)}` : '';
  const starter = profile.starterTemplateId ? ` starter=${profile.starterTemplateId}` : '';
  return `  ${profile.id}  home ${profile.homeDirectory}${created}${starter}`;
}

function renderProfilesResult(result: AgentRuntimeProfileCommandResult): string {
  if (!result.ok) return result.error ?? 'Agent profile command failed.';
  if (result.kind === 'agent.profiles.list') {
    const profiles = result.data?.profiles ?? [];
    if (profiles.length === 0) {
      return [
        'No Agent profiles',
        '  next goodvibes-agent profiles create <name> --template <id> --yes',
      ].join('\n');
    }
    return [
      `Agent profiles (${profiles.length})`,
      ...profiles.map(profileLine),
    ].join('\n');
  }
  if (result.kind === 'agent.profiles.templates') {
    const templates = result.data?.templates ?? [];
    return [
      `Agent starter profile templates (${templates.length})`,
      ...templates.map((template) => [
        `  ${template.id}  ${template.name} [${formatAgentRecordSource(template.source).toLowerCase()}]`,
        `    ${template.description}`,
        `    persona ${template.personaName}`,
        `    skills ${template.skillNames.join(', ')}`,
        `    routines ${template.routineNames.join(', ')}`,
        template.vibeIncluded ? '    vibe included' : '',
      ].filter(Boolean).join('\n')),
      'Use goodvibes-agent profiles create <name> --template <id> --yes',
      'Export/edit/import with goodvibes-agent profiles templates export <id> <path> [--include-vibe] --yes',
    ].join('\n');
  }
  if (result.kind === 'agent.profiles.template.export' && result.data?.template && result.data.path) {
    return [
      `Agent starter template exported: ${result.data.template.id}`,
      `  path ${result.data.path}`,
      result.data.template.vibeIncluded ? '  vibe included' : '',
      '  edit the JSON, then import it with goodvibes-agent profiles templates import <path> --yes',
    ].filter(Boolean).join('\n');
  }
  if (result.kind === 'agent.profiles.template.import' && result.data?.template) {
    return [
      `Agent starter template imported: ${result.data.template.id}`,
      `  name ${result.data.template.name}`,
      `  origin ${formatAgentRecordSource(result.data.template.source)}`,
      result.data.template.vibeIncluded ? '  vibe included' : '',
      `  use goodvibes-agent profiles create <name> --template ${result.data.template.id} --yes`,
    ].filter(Boolean).join('\n');
  }
  if (result.kind === 'agent.profiles.template.from_discovered' && result.data?.template) {
    return [
      `Agent starter template created from discovered behavior: ${result.data.template.id}`,
      `  name ${result.data.template.name}`,
      `  persona ${result.data.template.personaName}`,
      `  skills ${result.data.template.skillNames.join(', ')}`,
      `  routines ${result.data.template.routineNames.join(', ')}`,
      result.data.template.vibeIncluded ? '  vibe included' : '',
      `  use goodvibes-agent profiles create <name> --template ${result.data.template.id} --yes`,
    ].filter(Boolean).join('\n');
  }
  if (result.kind === 'agent.profiles.default') {
    const selected = result.data?.selectedProfile;
    if (!selected) {
      return [
        'No default Agent profile selected',
        '  next goodvibes-agent profiles use <name> --yes',
      ].join('\n');
    }
    return [
      `Default Agent profile: ${selected.id}${selected.exists ? '' : ' (missing)'}`,
      `  home ${selected.homeDirectory}`,
      selected.selectedAt ? `  selected ${selected.selectedAt}` : '',
      `  next launch: ${result.data?.nextCommand ?? 'goodvibes-agent'}`,
      selected.exists ? '' : '  fix create the profile again or clear it with goodvibes-agent profiles default clear --yes',
    ].filter(Boolean).join('\n');
  }
  if (result.kind === 'agent.profiles.default.clear') {
    return [
      'Default Agent profile cleared',
      '  next launch uses the base Agent home unless --agent-profile is provided',
    ].join('\n');
  }
  if (result.kind === 'agent.profiles.create_from_discovered' && result.data?.profile && result.data.template) {
    return [
      `Agent profile created from discovered behavior: ${result.data.profile.id}`,
      `  home ${result.data.profile.homeDirectory}`,
      `  starter: ${result.data.template.id}`,
      `  persona ${result.data.template.personaName}`,
      `  skills ${result.data.template.skillNames.join(', ')}`,
      `  routines ${result.data.template.routineNames.join(', ')}`,
      result.data.template.vibeIncluded ? '  vibe included' : '',
      `  launch: ${result.data.nextCommand ?? `goodvibes-agent --agent-profile ${result.data.profile.id}`}`,
    ].filter(Boolean).join('\n');
  }
  const profile = result.data?.profile;
  if (result.kind === 'agent.profiles.create' && profile) {
    const template = result.data?.appliedTemplate;
    return [
      `Agent profile created: ${profile.id}`,
      `  home ${profile.homeDirectory}`,
      ...(template ? [
        `  starter: ${template.id} (${template.name})`,
        `  seeded: ${template.personaIds.length} persona, ${template.skillIds.length} skills, ${template.routineIds.length} routine`,
        template.vibePath ? `  vibe ${template.vibePath}` : '',
      ] : []),
      `  use ${result.data?.nextCommand ?? `goodvibes-agent --agent-profile ${profile.id}`}`,
    ].filter(Boolean).join('\n');
  }
  if (result.kind === 'agent.profiles.delete' && profile) {
    return [
      `Agent profile deleted: ${profile.id}`,
      `  id ${profile.id}`,
    ].join('\n');
  }
  return 'Agent profile command completed.';
}

function renderProfilesOutput(result: AgentRuntimeProfileCommandResult, format: string): string {
  if (format === 'json') return JSON.stringify(result, null, 2);
  return renderProfilesResult(result);
}

export async function handleProfilesCommand(runtime: ProfilesCommandRuntime): Promise<CliCommandOutput> {
  const [sub = 'list', ...rawRest] = runtime.cli.commandArgs;
  const values = commandValues(rawRest);

  try {
    if (sub === 'list' || sub === 'ls') {
      const result: AgentRuntimeProfileCommandResult = {
        ok: true,
        kind: 'agent.profiles.list',
        data: { profiles: listAgentRuntimeProfiles(runtime.homeDirectory) },
      };
      return {
        output: renderProfilesOutput(result, runtime.cli.flags.outputFormat),
        exitCode: 0,
      };
    }

    if (sub === 'templates' || sub === 'starters') {
      const [templateAction, templateId, templatePath] = values;
      if (templateAction === 'from-discovered' || templateAction === 'import-discovered') {
        if (!templateId) {
          const result: AgentRuntimeProfileCommandResult = {
            ok: false,
            kind: 'agent.profiles.error',
            error: 'Usage: goodvibes-agent profiles templates from-discovered <id> [--name <name>] [--description <summary>] [--persona <name>] [--skills all|name,name] [--routines all|name,name] [--include-vibe] [--replace] --yes',
          };
          return {
            output: renderProfilesOutput(result, runtime.cli.flags.outputFormat),
            exitCode: 2,
          };
        }
        if (!hasYes(rawRest)) {
          const result: AgentRuntimeProfileCommandResult = {
            ok: false,
            kind: 'agent.profiles.error',
            error: `Refusing to create Agent starter template ${templateId} from discovered behavior without --yes.`,
          };
          return {
            output: renderProfilesOutput(result, runtime.cli.flags.outputFormat),
            exitCode: 2,
          };
        }
        const template = await createAgentRuntimeProfileTemplateFromDiscovered({
          homeDirectory: runtime.homeDirectory,
          workingDirectory: runtime.workingDirectory,
        }, {
          id: templateId,
          name: flagValue(rawRest, ['--name']) ?? undefined,
          description: flagValue(rawRest, ['--description']) ?? undefined,
          persona: flagValue(rawRest, ['--persona']) ?? undefined,
          skills: parseCsvFlag(rawRest, ['--skills']),
          routines: parseCsvFlag(rawRest, ['--routines']),
          includeVibe: rawRest.includes('--include-vibe'),
          replace: hasYes(rawRest) && rawRest.includes('--replace'),
        });
        const result: AgentRuntimeProfileCommandResult = {
          ok: true,
          kind: 'agent.profiles.template.from_discovered',
          data: { template },
        };
        return {
          output: renderProfilesOutput(result, runtime.cli.flags.outputFormat),
          exitCode: 0,
        };
      }
      if (templateAction === 'export') {
        if (!templateId || !templatePath) {
          const result: AgentRuntimeProfileCommandResult = {
            ok: false,
            kind: 'agent.profiles.error',
            error: 'Usage: goodvibes-agent profiles templates export <id> <path> [--include-vibe] --yes',
          };
          return {
            output: renderProfilesOutput(result, runtime.cli.flags.outputFormat),
            exitCode: 2,
          };
        }
        if (!hasYes(rawRest)) {
          const result: AgentRuntimeProfileCommandResult = {
            ok: false,
            kind: 'agent.profiles.error',
            error: `Refusing to export Agent starter template ${templateId} without --yes.`,
          };
          return {
            output: renderProfilesOutput(result, runtime.cli.flags.outputFormat),
            exitCode: 2,
          };
        }
        const template = exportAgentRuntimeProfileTemplate(runtime.homeDirectory, templateId, templatePath, {
          includeVibe: rawRest.includes('--include-vibe'),
          shellPaths: {
            homeDirectory: runtime.homeDirectory,
            workingDirectory: runtime.workingDirectory,
          },
        });
        const result: AgentRuntimeProfileCommandResult = {
          ok: true,
          kind: 'agent.profiles.template.export',
          data: { template, path: templatePath },
        };
        return {
          output: renderProfilesOutput(result, runtime.cli.flags.outputFormat),
          exitCode: 0,
        };
      }
      if (templateAction === 'import') {
        if (!templateId) {
          const result: AgentRuntimeProfileCommandResult = {
            ok: false,
            kind: 'agent.profiles.error',
            error: 'Usage: goodvibes-agent profiles templates import <path> --yes',
          };
          return {
            output: renderProfilesOutput(result, runtime.cli.flags.outputFormat),
            exitCode: 2,
          };
        }
        if (!hasYes(rawRest)) {
          const result: AgentRuntimeProfileCommandResult = {
            ok: false,
            kind: 'agent.profiles.error',
            error: `Refusing to import Agent starter template ${templateId} without --yes.`,
          };
          return {
            output: renderProfilesOutput(result, runtime.cli.flags.outputFormat),
            exitCode: 2,
          };
        }
        const template = importAgentRuntimeProfileTemplate(runtime.homeDirectory, templateId);
        const result: AgentRuntimeProfileCommandResult = {
          ok: true,
          kind: 'agent.profiles.template.import',
          data: { template, path: templateId },
        };
        return {
          output: renderProfilesOutput(result, runtime.cli.flags.outputFormat),
          exitCode: 0,
        };
      }
      const result: AgentRuntimeProfileCommandResult = {
        ok: true,
        kind: 'agent.profiles.templates',
        data: { templates: listAgentRuntimeProfileTemplates(runtime.homeDirectory) },
      };
      return {
        output: renderProfilesOutput(result, runtime.cli.flags.outputFormat),
        exitCode: 0,
      };
    }

    if (sub === 'default') {
      const target = values[0];
      if (target === 'clear' || target === 'none' || target === 'base') {
        if (!hasYes(rawRest)) {
          const result: AgentRuntimeProfileCommandResult = {
            ok: false,
            kind: 'agent.profiles.error',
            error: 'Refusing to clear the default Agent profile without --yes.',
          };
          return {
            output: renderProfilesOutput(result, runtime.cli.flags.outputFormat),
            exitCode: 2,
          };
        }
        clearAgentRuntimeProfileSelection(runtime.homeDirectory);
        const result: AgentRuntimeProfileCommandResult = {
          ok: true,
          kind: 'agent.profiles.default.clear',
        };
        return {
          output: renderProfilesOutput(result, runtime.cli.flags.outputFormat),
          exitCode: 0,
        };
      }
      if (target) {
        if (!hasYes(rawRest)) {
          const result: AgentRuntimeProfileCommandResult = {
            ok: false,
            kind: 'agent.profiles.error',
            error: `Refusing to set default Agent profile ${target} without --yes.`,
          };
          return {
            output: renderProfilesOutput(result, runtime.cli.flags.outputFormat),
            exitCode: 2,
          };
        }
        const selected = setAgentRuntimeProfileSelection(runtime.homeDirectory, target);
        const result: AgentRuntimeProfileCommandResult = {
          ok: true,
          kind: 'agent.profiles.default',
          data: {
            selectedProfile: selected,
            nextCommand: 'goodvibes-agent',
          },
        };
        return {
          output: renderProfilesOutput(result, runtime.cli.flags.outputFormat),
          exitCode: 0,
        };
      }
      const selected = readAgentRuntimeProfileSelection(runtime.homeDirectory);
      const result: AgentRuntimeProfileCommandResult = {
        ok: true,
        kind: 'agent.profiles.default',
        data: selected ? { selectedProfile: selected, nextCommand: 'goodvibes-agent' } : undefined,
      };
      return {
        output: renderProfilesOutput(result, runtime.cli.flags.outputFormat),
        exitCode: 0,
      };
    }

    if (sub === 'use' || sub === 'select' || sub === 'switch') {
      const name = values[0];
      if (!name) {
        const result: AgentRuntimeProfileCommandResult = {
          ok: false,
          kind: 'agent.profiles.error',
          error: 'Usage: goodvibes-agent profiles use <name> --yes',
        };
        return {
          output: renderProfilesOutput(result, runtime.cli.flags.outputFormat),
          exitCode: 2,
        };
      }
      if (!hasYes(rawRest)) {
        const result: AgentRuntimeProfileCommandResult = {
          ok: false,
          kind: 'agent.profiles.error',
          error: `Refusing to set default Agent profile ${name} without --yes.`,
        };
        return {
          output: renderProfilesOutput(result, runtime.cli.flags.outputFormat),
          exitCode: 2,
        };
      }
      const selected = setAgentRuntimeProfileSelection(runtime.homeDirectory, name);
      const result: AgentRuntimeProfileCommandResult = {
        ok: true,
        kind: 'agent.profiles.default',
        data: {
          selectedProfile: selected,
          nextCommand: 'goodvibes-agent',
        },
      };
      return {
        output: renderProfilesOutput(result, runtime.cli.flags.outputFormat),
        exitCode: 0,
      };
    }

    if (sub === 'show' || sub === 'path' || sub === 'home') {
      const name = values[0];
      if (!name) {
        const result: AgentRuntimeProfileCommandResult = {
          ok: false,
          kind: 'agent.profiles.error',
          error: 'Usage: goodvibes-agent profiles show <name>',
        };
        return {
          output: renderProfilesOutput(result, runtime.cli.flags.outputFormat),
          exitCode: 2,
        };
      }
      const profile = resolveAgentRuntimeProfileHome(runtime.homeDirectory, name);
      const info = listAgentRuntimeProfiles(runtime.homeDirectory).find((entry) => entry.id === profile.id) ?? { ...profile, createdAt: null };
      const result: AgentRuntimeProfileCommandResult = {
        ok: true,
        kind: 'agent.profiles.show',
        data: { profile: info },
      };
      const starter = info.starterTemplateId ? [`  starter: ${info.starterTemplateId} (${info.starterTemplateName ?? info.starterTemplateId})`] : [];
      const text = [`Agent profile: ${profile.id}`, `  home ${profile.homeDirectory}`, ...starter, `  use goodvibes-agent --agent-profile ${profile.id}`].join('\n');
      return {
        output: runtime.cli.flags.outputFormat === 'json' ? JSON.stringify(result, null, 2) : text,
        exitCode: 0,
      };
    }

    if (sub === 'create') {
      const name = values[0];
      if (!name) {
        const result: AgentRuntimeProfileCommandResult = {
          ok: false,
          kind: 'agent.profiles.error',
          error: 'Usage: goodvibes-agent profiles create <name> [--template <id>] --yes',
        };
        return {
          output: renderProfilesOutput(result, runtime.cli.flags.outputFormat),
          exitCode: 2,
        };
      }
      if (!hasYes(rawRest)) {
        const result: AgentRuntimeProfileCommandResult = {
          ok: false,
          kind: 'agent.profiles.error',
          error: `Refusing to create Agent profile ${name} without --yes.`,
        };
        return {
          output: renderProfilesOutput(result, runtime.cli.flags.outputFormat),
          exitCode: 2,
        };
      }
      const templateId = parseTemplate(rawRest);
      const profile = createAgentRuntimeProfile(runtime.homeDirectory, name, { templateId });
      const result: AgentRuntimeProfileCommandResult = {
        ok: true,
        kind: 'agent.profiles.create',
        data: {
          profile,
          appliedTemplate: profile.starterTemplateApplication,
          nextCommand: `goodvibes-agent --agent-profile ${profile.id}`,
        },
      };
      return {
        output: renderProfilesOutput(result, runtime.cli.flags.outputFormat),
        exitCode: 0,
      };
    }

    if (sub === 'create-from-discovered' || sub === 'create-discovered') {
      const name = values[0];
      if (!name) {
        const result: AgentRuntimeProfileCommandResult = {
          ok: false,
          kind: 'agent.profiles.error',
          error: 'Usage: goodvibes-agent profiles create-from-discovered <name> [--template-id <id>] [--profile-name <display>] [--description <summary>] [--persona <name>] [--skills all|name,name] [--routines all|name,name] [--include-vibe] [--replace] --yes',
        };
        return {
          output: renderProfilesOutput(result, runtime.cli.flags.outputFormat),
          exitCode: 2,
        };
      }
      if (!hasYes(rawRest)) {
        const result: AgentRuntimeProfileCommandResult = {
          ok: false,
          kind: 'agent.profiles.error',
          error: `Refusing to create Agent profile ${name} from discovered behavior without --yes.`,
        };
        return {
          output: renderProfilesOutput(result, runtime.cli.flags.outputFormat),
          exitCode: 2,
        };
      }
      const created = await createAgentRuntimeProfileFromDiscovered({
        homeDirectory: runtime.homeDirectory,
        workingDirectory: runtime.workingDirectory,
      }, {
        profileName: name,
        templateId: flagValue(rawRest, ['--template-id', '--starter-id']) ?? undefined,
        name: flagValue(rawRest, ['--profile-name', '--name']) ?? undefined,
        description: flagValue(rawRest, ['--description']) ?? undefined,
        persona: flagValue(rawRest, ['--persona']) ?? undefined,
        skills: parseCsvFlag(rawRest, ['--skills']),
        routines: parseCsvFlag(rawRest, ['--routines']),
        includeVibe: rawRest.includes('--include-vibe'),
        replace: rawRest.includes('--replace'),
      });
      const result: AgentRuntimeProfileCommandResult = {
        ok: true,
        kind: 'agent.profiles.create_from_discovered',
        data: {
          profile: created.profile,
          appliedTemplate: created.profile.starterTemplateApplication,
          template: created.template,
          nextCommand: `goodvibes-agent --agent-profile ${created.profile.id}`,
        },
      };
      return {
        output: renderProfilesOutput(result, runtime.cli.flags.outputFormat),
        exitCode: 0,
      };
    }

    if (sub === 'delete' || sub === 'remove') {
      const name = values[0];
      if (!name) {
        const result: AgentRuntimeProfileCommandResult = {
          ok: false,
          kind: 'agent.profiles.error',
          error: 'Usage: goodvibes-agent profiles delete <name> --yes',
        };
        return {
          output: renderProfilesOutput(result, runtime.cli.flags.outputFormat),
          exitCode: 2,
        };
      }
      if (!hasYes(rawRest)) {
        const result: AgentRuntimeProfileCommandResult = {
          ok: false,
          kind: 'agent.profiles.error',
          error: `Refusing to delete Agent profile ${name} without --yes.`,
        };
        return {
          output: renderProfilesOutput(result, runtime.cli.flags.outputFormat),
          exitCode: 2,
        };
      }
      const resolution = resolveAgentRuntimeProfileHome(runtime.homeDirectory, name);
      const deleted = deleteAgentRuntimeProfile(runtime.homeDirectory, name);
      const result: AgentRuntimeProfileCommandResult = deleted
        ? {
          ok: true,
          kind: 'agent.profiles.delete',
          data: { profile: { ...resolution, createdAt: null } },
        }
        : {
          ok: false,
          kind: 'agent.profiles.error',
          error: `Agent profile not found ${resolution.id}`,
        };
      return {
        output: renderProfilesOutput(result, runtime.cli.flags.outputFormat),
        exitCode: deleted ? 0 : 1,
      };
    }

    const result: AgentRuntimeProfileCommandResult = {
      ok: false,
      kind: 'agent.profiles.error',
      error: 'Usage: goodvibes-agent profiles [list|templates|default [<name>|clear] --yes|use <name> --yes|show <name>|create <name> [--template <id>] --yes|delete <name> --yes]',
    };
    return {
      output: renderProfilesOutput(result, runtime.cli.flags.outputFormat),
      exitCode: 2,
    };
  } catch (error) {
    const result: AgentRuntimeProfileCommandResult = {
      ok: false,
      kind: 'agent.profiles.error',
      error: error instanceof Error ? error.message : String(error),
    };
    return {
      output: renderProfilesOutput(result, runtime.cli.flags.outputFormat),
      exitCode: 2,
    };
  }
}
