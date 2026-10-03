import { isAbsolute, resolve } from 'node:path';
import {
  MemoryEmbeddingProviderRegistry,
  MemoryRegistry,
  MemoryStore,
  resolveCanonicalMemoryDbPath,
} from '@goodvibes-jev/engine/sdk/platform/state';
import { assertNoSecretLikeMemoryText } from '../agent/memory-safety.ts';
import { buildAgentSkillRequirements } from '../agent/skill-registry.ts';
import type { CliCommandOutput } from './types.ts';
import type { CliCommandRuntime } from './management.ts';
import { failure, personaRegistry, skillRegistry, success } from './local-library-command-shared.ts';
import {
  OPENCLAW_LAYOUT_VERSION,
  scanOpenClawWorkspace,
  type OpenClawImportPlan,
} from './openclaw-import.ts';

/**
 * `goodvibes-agent import openclaw [path]`, migrate an OpenClaw workspace into
 * the Agent's existing registries. Dry-run is the DEFAULT (prints what would be
 * created); --apply performs the writes through the persona registry, the
 * canonical memory store, the skill registry, and the permission settings. No
 * parallel storage is invented. See openclaw-import.ts for the targeted layout.
 */

interface ApplyCounts {
  created: number;
  skipped: number;
}

function resolveSourcePath(runtime: CliCommandRuntime, arg: string | undefined): string {
  // Home is taken from the runtime's owned home root (the composition root passes
  // it in), never discovered implicitly. Default workspace is <home>/.openclaw.
  if (!arg) return resolve(runtime.homeDirectory, '.openclaw');
  if (arg.startsWith('~')) return resolve(runtime.homeDirectory, arg.slice(1).replace(/^[/\\]/, ''));
  if (isAbsolute(arg)) return arg;
  return resolve(runtime.workingDirectory, arg);
}

function planSummaryLines(plan: OpenClawImportPlan): string[] {
  const lines: string[] = [];
  lines.push(`  personas: ${plan.personas.length}`);
  for (const persona of plan.personas) lines.push(`    - ${persona.name}  (${persona.sourcePath})`);
  lines.push(`  memory records: ${plan.memories.length}`);
  for (const memory of plan.memories) lines.push(`    - ${memory.scope}/${memory.cls}  ${memory.summary}`);
  lines.push(`  skills: ${plan.skills.length}`);
  for (const skill of plan.skills) lines.push(`    - ${skill.name}  (${skill.sourcePath})`);
  const perm = plan.permissions;
  lines.push(`  permission allowlist: ${perm.categories.length} categor${perm.categories.length === 1 ? 'y' : 'ies'}${perm.sourcePath ? ` (${perm.sourcePath})` : ''}`);
  if (perm.categories.length > 0) lines.push(`    - allow: ${perm.categories.join(', ')}  (mode -> custom)`);
  lines.push(`  skipped: ${plan.skipped.length}`);
  for (const entry of plan.skipped) lines.push(`    - ${entry.path}: ${entry.reason}`);
  return lines;
}

function renderDryRun(plan: OpenClawImportPlan): string {
  return [
    `OpenClaw import (dry run), layout ${OPENCLAW_LAYOUT_VERSION}`,
    `  source ${plan.sourcePath}`,
    ...planSummaryLines(plan),
    '',
    '  This is a preview. Re-run with --apply to write these into the Agent registries.',
  ].join('\n');
}

async function applyMemories(
  runtime: CliCommandRuntime,
  plan: OpenClawImportPlan,
  notes: string[],
): Promise<ApplyCounts> {
  const counts: ApplyCounts = { created: 0, skipped: 0 };
  if (plan.memories.length === 0) return counts;
  const path = resolveCanonicalMemoryDbPath(runtime.homeDirectory);
  const embeddingRegistry = new MemoryEmbeddingProviderRegistry({ configManager: runtime.configManager });
  const store = new MemoryStore(path, { embeddingRegistry });
  await store.init();
  const registry = new MemoryRegistry(store);
  try {
    for (const memory of plan.memories) {
      try {
        assertNoSecretLikeMemoryText([memory.summary, memory.detail ?? '', ...memory.tags]);
        await registry.add({
          scope: memory.scope as 'session' | 'project' | 'team',
          cls: memory.cls as 'fact',
          summary: memory.summary,
          detail: memory.detail,
          tags: [...memory.tags],
          provenance: [{ kind: 'event', ref: `openclaw-import:${memory.sourcePath}` }],
        });
        counts.created += 1;
      } catch (error) {
        counts.skipped += 1;
        notes.push(`  memory skipped (${memory.summary}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await store.save();
    store.close();
  }
  return counts;
}

function applyPersonas(runtime: CliCommandRuntime, plan: OpenClawImportPlan, notes: string[]): ApplyCounts {
  const counts: ApplyCounts = { created: 0, skipped: 0 };
  const registry = personaRegistry(runtime);
  for (const persona of plan.personas) {
    try {
      registry.create({
        name: persona.name,
        description: persona.description,
        body: persona.body,
        tags: [...persona.tags],
        source: 'imported',
        provenance: `openclaw-import:${persona.sourcePath}`,
      });
      counts.created += 1;
    } catch (error) {
      counts.skipped += 1;
      notes.push(`  persona skipped (${persona.name}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return counts;
}

function applySkills(runtime: CliCommandRuntime, plan: OpenClawImportPlan, notes: string[]): ApplyCounts {
  const counts: ApplyCounts = { created: 0, skipped: 0 };
  const registry = skillRegistry(runtime);
  for (const skill of plan.skills) {
    try {
      registry.create({
        name: skill.name,
        description: skill.description,
        procedure: skill.procedure,
        tags: [...skill.tags],
        requirements: buildAgentSkillRequirements({ env: skill.requiresEnv, commands: skill.requiresCommand }),
        source: 'imported',
        provenance: `openclaw-import:${skill.sourcePath}`,
      });
      counts.created += 1;
    } catch (error) {
      counts.skipped += 1;
      notes.push(`  skill skipped (${skill.name}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return counts;
}

function applyPermissions(runtime: CliCommandRuntime, plan: OpenClawImportPlan): number {
  const categories = plan.permissions.categories;
  if (categories.length === 0) return 0;
  runtime.configManager.setDynamic('permissions.mode', 'custom');
  for (const category of categories) {
    runtime.configManager.setDynamic(`permissions.tools.${category}` as never, 'allow');
  }
  return categories.length;
}

async function renderApply(runtime: CliCommandRuntime, plan: OpenClawImportPlan): Promise<string> {
  const notes: string[] = [];
  const personas = applyPersonas(runtime, plan, notes);
  const memories = await applyMemories(runtime, plan, notes);
  const skills = applySkills(runtime, plan, notes);
  const permissionCategories = applyPermissions(runtime, plan);
  return [
    `OpenClaw import (applied), layout ${OPENCLAW_LAYOUT_VERSION}`,
    `  source ${plan.sourcePath}`,
    `  personas created ${personas.created}${personas.skipped ? ` (skipped ${personas.skipped})` : ''}`,
    `  memory records created ${memories.created}${memories.skipped ? ` (skipped ${memories.skipped})` : ''}`,
    `  skills created ${skills.created}${skills.skipped ? ` (skipped ${skills.skipped})` : ''}`,
    `  permission categories allowed ${permissionCategories}${permissionCategories ? ` (${plan.permissions.categories.join(', ')}; mode -> custom)` : ''}`,
    `  input files skipped ${plan.skipped.length}`,
    ...notes,
  ].join('\n');
}

function usageImport(): string {
  return 'Usage: goodvibes-agent import openclaw [path] [--apply]';
}

export async function handleImportCommand(runtime: CliCommandRuntime): Promise<CliCommandOutput> {
  try {
    const [sourceRaw, ...rest] = runtime.cli.commandArgs;
    const source = (sourceRaw ?? '').toLowerCase();
    if (!source) return failure(runtime, 'invalid_import_command', usageImport(), 2);
    if (source !== 'openclaw') {
      return failure(runtime, 'unknown_import_source', `Unknown import source "${sourceRaw}". Supported sources: openclaw.\n${usageImport()}`, 2);
    }
    const apply = rest.includes('--apply');
    const pathArg = rest.find((arg) => !arg.startsWith('--'));
    const sourcePath = resolveSourcePath(runtime, pathArg);
    const plan = scanOpenClawWorkspace(sourcePath);
    if (!plan.exists) {
      const message = pathArg
        ? `OpenClaw workspace not found at ${sourcePath}.`
        : `No OpenClaw workspace found at the default location ${sourcePath}. Pass a path: goodvibes-agent import openclaw <path>.`;
      return failure(runtime, 'openclaw_workspace_missing', message, 1);
    }
    if (apply) {
      const output = await renderApply(runtime, plan);
      return success(runtime, 'agent.import.openclaw.apply', plan, output);
    }
    return success(runtime, 'agent.import.openclaw.dryRun', plan, renderDryRun(plan));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(runtime, 'agent.import.error', message, 1);
  }
}
